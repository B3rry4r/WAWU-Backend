import type {
  AbroadBank,
  AbroadHolder,
  AbroadLookup,
  AbroadProvider,
  AbroadProviderQuote,
  AbroadQuoteInput,
  AbroadRecipientInput,
  AbroadRecipientSaved,
  AbroadSendInput,
  AbroadSource,
  AbroadTransfer,
  AbroadTransferState,
} from '../../wallet-provider/abroad-provider';
import { AbroadRefusal } from '../../wallet-provider/abroad-provider';
import { WalletProviderError } from '../../wallet-provider/wallet-provider-error';
import type { NuvionClient, NuvionOp } from '../nuvion-client';
import { NuvionError } from '../nuvion-error';
import { isNuvionId, readNuvionAccount, readNuvionWalletId } from './accounts';
import {
  NuvionPayoutsArea,
  type NuvionPayoutReading,
  readSenderContact,
} from './payouts';

const AREA = 'abroad (NUV-11)';

/** A bank directory is asked once an hour per country (it changes rarely). */
export const NUVION_ABROAD_BANKS_TTL_MS = 60 * 60_000;

/** How long WAWU holds a quote when the currencies are the same and there is no provider quote. */
export const SAME_CURRENCY_HOLD_SECONDS = 10 * 60;

/** The currencies a person can hold an account in and send from (R-84). */
const SOURCE_CURRENCIES = ['NGN', 'USD', 'EUR', 'GBP', 'CAD', 'AED', 'GHS'];

const COUNTRY = /^[A-Z]{2}$/;
const NARRATION_MAX = 100;

/** Marks the counterparties this area makes, so a lost answer finds them again. */
export const ABROAD_META_KEY = 'wawu_abroad';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function text(o: Record<string, unknown>, key: string): string | null {
  const v = o[key];
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

function whole(o: Record<string, unknown>, key: string): number | null {
  const v = o[key];
  return typeof v === 'number' && Number.isSafeInteger(v) ? v : null;
}

/** Nuvion's field name as the corridor registry's key (the form's). */
export function formKeyOf(nuvionField: string): string {
  const f = nuvionField.replace(/^payment_detail\./, '');
  if (f.startsWith('bank_address.')) {
    return `bank_address_${f.slice('bank_address.'.length)}`;
  }
  return f;
}

/** The field names a Nuvion refusal complains about: its messages are `<field>: <text>`. */
export function complainedFields(e: WalletProviderError): string[] {
  const out = new Set<string>();
  for (const m of e.messages) {
    const at = m.indexOf(': ');
    if (at <= 0) continue;
    const field = m.slice(0, at);
    if (/^[a-z_.0-9]{1,60}$/.test(field)) out.add(formKeyOf(field));
  }
  return [...out];
}

function decimalText(rate: number): string {
  return rate.toLocaleString('en-US', {
    useGrouping: false,
    maximumFractionDigits: 12,
  });
}

/** Nuvion's transfer state as ours. `new` is dev's first word for a transfer just made. */
export function abroadState(status: string): AbroadTransferState | null {
  switch (status.toLowerCase()) {
    case 'successful':
      return 'completed';
    case 'new':
    case 'pending':
    case 'processing':
      return 'pending';
    case 'failed':
      return 'failed';
    case 'reversed':
      return 'reversed';
    default:
      return null;
  }
}

function asTransfer(t: NuvionPayoutReading): AbroadTransfer {
  return {
    id: t.id,
    state: abroadState(t.status) ?? 'pending',
    providerStatus: t.status,
    providerReason: t.statusReason,
    feeMinor: t.feeStated ? t.feeKobo : null,
    currency: t.currency,
    amountMinor: t.amountKobo,
    reference: t.uniqueReference,
    createdAt: t.createdAt,
  };
}

/**
 * Sending abroad on Nuvion (task NUV-11, R-84): the bank directory of a
 * country (`GET /bank-codes/{country}`), the person's accounts
 * (`GET /accounts`), a recipient (`POST /counterparties` and
 * `POST /payment-details`), a conversion quote (`POST /fx-quotes`) and the
 * payout (`POST /transfers`, our reference as `unique_reference`, the quote as
 * `fx_quote_id`). Facts are Nuvion's docs (send-a-payout, cross-currency-
 * payouts, counterparties, payment-details, bank-codes, fx-quotes, transfers)
 * and the dev answers of 24 Oct 2026 in the mobile repo's
 * docs/nuvion/DEV-RESULTS.md (NUV-11):
 * - the transfer's `currency` is the SOURCE account's, with the quote's
 *   `amount_from` as `amount`; without a quote the currency must be the
 *   recipient's;
 * - a US bank is asked for the bank's address and the account type at the
 *   transfer, not at the payment detail;
 * - an account number is unique within an entity (`error_duplicate_resource`),
 *   so a repeat is found again, never made twice;
 * - dev gave no rate for naira to cedis, shillings, dirhams, rand, pesos, yuan
 *   or pesos (HTTP 500 `error_system_dependency_unavailable`), said so
 *   plainly here as `rate_unavailable`;
 * - there is no way to cancel a transfer (404).
 * A write whose answer is lost is rethrown as it is (`outcome_unknown`) for
 * the money layer to find by reference; it is never sent again from here.
 * This file is NUV-11's alone.
 */
export class NuvionAbroadArea implements AbroadProvider {
  private readonly directory = new Map<
    string,
    { at: number; banks: AbroadBank[] }
  >();
  private readonly payouts: NuvionPayoutsArea;

  constructor(
    private readonly client: NuvionClient,
    private readonly clock: () => number = Date.now,
    payouts?: NuvionPayoutsArea,
  ) {
    this.payouts = payouts ?? new NuvionPayoutsArea(client);
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async banks(country: string): Promise<AbroadBank[]> {
    const op: NuvionOp = { name: 'bank directory', call: 'read' };
    if (!COUNTRY.test(country)) {
      throw new AbroadRefusal(
        'corridor_not_supported',
        'That is not a country we can send to.',
      );
    }
    const hit = this.directory.get(country);
    if (hit && this.clock() - hit.at < NUVION_ABROAD_BANKS_TTL_MS) {
      return hit.banks;
    }
    const answer = await this.client.get<unknown>(op, `/bank-codes/${country}`);
    const rows = Array.isArray(answer.data) ? answer.data : [];
    const banks: AbroadBank[] = [];
    for (const row of rows) {
      if (!isRecord(row)) continue;
      const code =
        text(row, 'bank_code') ?? text(row, 'bank_institution_number');
      const name = text(row, 'bank_name');
      if (code === null || name === null) continue;
      banks.push({ code, name, swiftBic: text(row, 'swift_bic') });
    }
    banks.sort((a, b) => a.name.localeCompare(b.name));
    this.directory.set(country, { at: this.clock(), banks });
    return banks;
  }

  async sources(holder: AbroadHolder): Promise<AbroadSource[]> {
    const op: NuvionOp = { name: 'list accounts', call: 'read' };
    const ids = readNuvionWalletId(holder.walletId);
    if (!ids) {
      throw new NuvionError({
        kind: 'validation',
        operation: op.name,
        messages: [`${AREA}: the wallet is not one of Nuvion's`],
      });
    }
    const listed = await this.client.listAll<unknown>(op, '/accounts', {
      entity_id: ids.entityId,
      limit: 100,
    });
    const byCurrency = new Map<string, AbroadSource>();
    for (const raw of listed.items) {
      const a = readNuvionAccount(raw);
      if (!a || a.deleted || a.currency === null) continue;
      if (!SOURCE_CURRENCIES.includes(a.currency)) continue;
      if (a.type !== null && a.type !== 'checking') continue;
      // The naira source is the person's own wallet and no other naira account.
      if (a.currency === 'NGN' && a.id !== ids.accountId) continue;
      if (byCurrency.has(a.currency)) continue;
      const name =
        isRecord(raw) && typeof raw.display_name === 'string'
          ? raw.display_name
          : null;
      byCurrency.set(a.currency, {
        currency: a.currency,
        accountRef: a.id,
        displayName: name,
        availableMinor: a.available,
      });
    }
    return SOURCE_CURRENCIES.flatMap((c) => byCurrency.get(c) ?? []);
  }

  // -------------------------------------------------------------------------
  // A recipient
  // -------------------------------------------------------------------------

  async saveRecipient(
    input: AbroadRecipientInput,
  ): Promise<AbroadRecipientSaved> {
    const ids = readNuvionWalletId(input.holder.walletId);
    if (!ids || !COUNTRY.test(input.country)) {
      throw new NuvionError({
        kind: 'validation',
        operation: 'save recipient',
        messages: [`${AREA}: the wallet or the country is not usable`],
      });
    }
    const entityId = ids.entityId;
    let bankName: string | null = input.fields.bank_name ?? null;
    const body: Record<string, unknown> = {
      payment_method:
        input.method === 'mobile_money' ? 'momo-transfer' : 'bank-transfer',
      currency: input.currency,
      country: input.country,
      account_holder_name: input.holderName,
      entity_id: entityId,
      ...(input.scheme === null ? {} : { scheme: input.scheme }),
    };
    const address: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.fields)) {
      if (key === 'bank') {
        const bank = (await this.banks(input.country)).find(
          (b) => b.code === value,
        );
        if (!bank) {
          throw new AbroadRefusal(
            'invalid_details',
            'Choose the bank from the list.',
            { fields: ['bank'] },
          );
        }
        body.bank_code = bank.code;
        body.bank_name = bank.name;
        bankName = bank.name;
      } else if (key.startsWith('bank_address_')) {
        address[key.slice('bank_address_'.length)] = value;
      } else {
        body[key] = value;
      }
    }
    if (Object.keys(address).length > 0) {
      body.bank_address = { ...address, country: input.country };
    }

    const counterpartyId = await this.counterpartyFor(
      entityId,
      input.marker,
      input.holderName,
    );
    body.counterparty_id = counterpartyId;
    const op: NuvionOp = { name: 'create payment detail', call: 'write' };
    try {
      const answer = await this.client.post<unknown>(
        op,
        '/payment-details',
        body,
      );
      const id = isRecord(answer.data) ? text(answer.data, 'id') : null;
      if (isNuvionId(id)) {
        return { counterpartyId, paymentDetailId: id, bankName };
      }
      throw new NuvionError({
        kind: 'not_confirmed',
        operation: op.name,
        httpStatus: answer.httpStatus,
        messages: [`${AREA}: the answer carries no payment detail`],
        recordMayExist: true,
        requestId: answer.requestId,
      });
    } catch (e) {
      if (e instanceof WalletProviderError) {
        if (
          e instanceof NuvionError &&
          e.nuvionType === 'error_duplicate_resource'
        ) {
          const found = await this.findDetail(entityId, input);
          if (found) return { ...found, bankName };
        }
        throw this.refusal(e) ?? e;
      }
      throw e;
    }
  }

  /** The counterparty of one recipient: found by our marker, else made with the sender's own email and address. */
  private async counterpartyFor(
    entityId: string,
    marker: string,
    holderName: string,
  ): Promise<string> {
    const listOp: NuvionOp = { name: 'find counterparty', call: 'read' };
    const listed = await this.client.listAll<unknown>(
      listOp,
      '/counterparties',
      { entity_id: entityId, limit: 100 },
      { maxPages: 5 },
    );
    for (const row of listed.items) {
      if (!isRecord(row)) continue;
      const meta = isRecord(row.meta) ? row.meta : {};
      const id = text(row, 'id');
      if (meta[ABROAD_META_KEY] === marker && isNuvionId(id)) return id;
    }
    const entityOp: NuvionOp = { name: 'read sender entity', call: 'read' };
    const entity = await this.client.get<unknown>(
      entityOp,
      `/entities/${encodeURIComponent(entityId)}`,
      { entity_id: entityId },
    );
    const contact = readSenderContact(entity.data);
    if (contact.email === null || contact.address === null) {
      throw new AbroadRefusal(
        'declined',
        `We cannot set up a payout yet: your ${contact.missing.join(' and ')} is not on file. Update your details and try again.`,
      );
    }
    const [first, ...rest] = holderName.trim().split(/\s+/);
    const op: NuvionOp = { name: 'create counterparty', call: 'write' };
    const answer = await this.client.post<unknown>(op, '/counterparties', {
      type: 'individual',
      entity_id: entityId,
      profile: {
        first_name: first,
        last_name: rest.length > 0 ? rest.join(' ') : first,
        relationship: 'vendor',
        email: contact.email,
        address: contact.address,
      },
      meta: { [ABROAD_META_KEY]: marker },
    });
    const id = isRecord(answer.data) ? text(answer.data, 'id') : null;
    if (isNuvionId(id)) return id;
    throw new NuvionError({
      kind: 'not_confirmed',
      operation: op.name,
      httpStatus: answer.httpStatus,
      messages: [`${AREA}: the answer carries no counterparty`],
      recordMayExist: true,
      requestId: answer.requestId,
    });
  }

  /** The payment detail Nuvion already holds for these coordinates (an account number is unique per entity). */
  private async findDetail(
    entityId: string,
    input: AbroadRecipientInput,
  ): Promise<{ counterpartyId: string; paymentDetailId: string } | null> {
    const identity = ['account_number', 'iban', 'phone_number', 'email'].find(
      (k) => input.fields[k] !== undefined,
    );
    if (!identity) return null;
    const want = input.fields[identity].replace(/\s+/g, '').toLowerCase();
    const listOp: NuvionOp = { name: 'find counterparties', call: 'read' };
    const counterparties = await this.client.listAll<unknown>(
      listOp,
      '/counterparties',
      { entity_id: entityId, limit: 100 },
      { maxPages: 5 },
    );
    for (const cp of counterparties.items) {
      const cpId = isRecord(cp) ? text(cp, 'id') : null;
      if (!isNuvionId(cpId)) continue;
      const details = await this.client.listAll<unknown>(
        { name: 'find payment details', call: 'read' },
        `/counterparties/${encodeURIComponent(cpId)}/payment-details`,
        { entity_id: entityId, limit: 100 },
        { maxPages: 3 },
      );
      for (const d of details.items) {
        if (!isRecord(d)) continue;
        const id = text(d, 'id');
        const have = text(d, identity);
        if (
          isNuvionId(id) &&
          have !== null &&
          have.replace(/\s+/g, '').toLowerCase() === want &&
          text(d, 'currency')?.toUpperCase() === input.currency &&
          (d.deleted === undefined || d.deleted === 0)
        ) {
          return { counterpartyId: cpId, paymentDetailId: id };
        }
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // A quote
  // -------------------------------------------------------------------------

  async quote(input: AbroadQuoteInput): Promise<AbroadProviderQuote> {
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
      throw new AbroadRefusal(
        'amount_out_of_range',
        'Enter an amount above zero.',
      );
    }
    if (input.fromCurrency === input.toCurrency) {
      return {
        quoteRef: null,
        amountFromMinor: input.amountMinor,
        amountToMinor: input.amountMinor,
        rate: null,
        expiresAt: new Date(this.clock() + SAME_CURRENCY_HOLD_SECONDS * 1000),
        validForSeconds: SAME_CURRENCY_HOLD_SECONDS,
      };
    }
    const ids = readNuvionWalletId(input.holder.walletId);
    if (!ids || !isNuvionId(input.fromAccountRef)) {
      throw new NuvionError({
        kind: 'validation',
        operation: 'fx quote',
        messages: [`${AREA}: the wallet or the account is not usable`],
      });
    }
    const op: NuvionOp = { name: 'fx quote', call: 'read' };
    try {
      // A quote makes nothing that moves money, so a quote whose answer is lost is simply asked for again.
      const answer = await this.client.post<unknown>(op, '/fx-quotes', {
        from_currency: input.fromCurrency,
        to_currency: input.toCurrency,
        [input.side === 'send' ? 'amount_from' : 'amount_to']:
          input.amountMinor,
        account_id: input.fromAccountRef,
        entity_id: ids.entityId,
      });
      return this.readQuote(answer.data, input);
    } catch (e) {
      if (e instanceof WalletProviderError) throw this.refusal(e, 'quote') ?? e;
      throw e;
    }
  }

  private readQuote(
    data: unknown,
    input: AbroadQuoteInput,
  ): AbroadProviderQuote {
    const unreadable = () =>
      new NuvionError({
        kind: 'bad_response',
        operation: 'fx quote',
        messages: [`${AREA}: the quote cannot be read`],
      });
    if (!isRecord(data)) throw unreadable();
    const id = text(data, 'id');
    const from = whole(data, 'amount_from');
    const to = whole(data, 'amount_to');
    const rate = data.rate;
    const q = isRecord(data.quote) ? data.quote : {};
    const expires = q.expires_at;
    const valid = whole(q, 'valid_for');
    if (
      !isNuvionId(id) ||
      from === null ||
      to === null ||
      from <= 0 ||
      to <= 0 ||
      typeof rate !== 'number' ||
      !(rate > 0) ||
      typeof expires !== 'number' ||
      valid === null ||
      text(data, 'from')?.toUpperCase() !== input.fromCurrency ||
      text(data, 'to')?.toUpperCase() !== input.toCurrency
    ) {
      throw unreadable();
    }
    return {
      quoteRef: id,
      amountFromMinor: from,
      amountToMinor: to,
      rate: decimalText(rate),
      expiresAt: new Date(expires),
      validForSeconds: valid,
    };
  }

  // -------------------------------------------------------------------------
  // The send, and reading it back
  // -------------------------------------------------------------------------

  async send(input: AbroadSendInput): Promise<AbroadTransfer> {
    const ids = readNuvionWalletId(input.holder.walletId);
    if (
      !ids ||
      !isNuvionId(input.fromAccountRef) ||
      !isNuvionId(input.counterpartyId) ||
      !isNuvionId(input.paymentDetailId) ||
      !/^[A-Za-z0-9._:-]{1,64}$/.test(input.reference) ||
      (input.quoteRef !== null && !isNuvionId(input.quoteRef))
    ) {
      throw new NuvionError({
        kind: 'validation',
        operation: 'abroad transfer',
        messages: [
          `${AREA}: an id or the reference is not in the form Nuvion uses`,
        ],
        reference: null,
        recordMayExist: false,
      });
    }
    if (input.fromCurrency !== input.toCurrency && input.quoteRef === null) {
      throw new NuvionError({
        kind: 'validation',
        operation: 'abroad transfer',
        messages: [`${AREA}: two currencies need a quote`],
        recordMayExist: false,
      });
    }
    const op: NuvionOp = { name: 'abroad transfer', call: 'write' };
    try {
      const answer = await this.client.post<unknown>(
        op,
        '/transfers',
        {
          account_id: input.fromAccountRef,
          payment_detail_id: input.paymentDetailId,
          counterparty_id: input.counterpartyId,
          amount: input.amountFromMinor,
          currency: input.fromCurrency,
          narration: input.narration.slice(0, NARRATION_MAX),
          payment_type:
            input.method === 'mobile_money' ? 'momo-transfer' : 'bank-transfer',
          unique_reference: input.reference,
          ...(input.quoteRef === null ? {} : { fx_quote_id: input.quoteRef }),
          entity_id: ids.entityId,
        },
        { reference: input.reference },
      );
      return this.readSent(answer, input);
    } catch (e) {
      if (e instanceof WalletProviderError) throw this.refusal(e, 'send') ?? e;
      throw e;
    }
  }

  private readSent(
    answer: { data: unknown; httpStatus: number; requestId: string | null },
    input: AbroadSendInput,
  ): AbroadTransfer {
    const lost = (why: string) =>
      new NuvionError({
        kind: 'not_confirmed',
        operation: 'abroad transfer',
        httpStatus: answer.httpStatus,
        messages: [`${AREA}: ${why}`],
        reference: input.reference,
        recordMayExist: true,
        requestId: answer.requestId,
      });
    const d = answer.data;
    if (!isRecord(d)) throw lost('the answer is not a transfer');
    const id = text(d, 'id');
    const status = text(d, 'status');
    const fee = d.applicable_fee;
    if (!isNuvionId(id) || status === null) {
      throw lost('the answer carries no transfer id or status');
    }
    if (text(d, 'unique_reference') !== input.reference) {
      throw lost('the answer is for another reference');
    }
    return {
      id,
      state: abroadState(status) ?? 'pending',
      providerStatus: status,
      providerReason: text(d, 'status_reason'),
      feeMinor:
        typeof fee === 'number' && Number.isSafeInteger(fee) && fee >= 0
          ? fee
          : null,
      currency: text(d, 'currency')?.toUpperCase() ?? input.fromCurrency,
      amountMinor: whole(d, 'amount') ?? input.amountFromMinor,
      reference: input.reference,
      createdAt: null,
    };
  }

  async read(
    holder: AbroadHolder,
    transferId: string,
  ): Promise<AbroadTransfer> {
    const ids = readNuvionWalletId(holder.walletId);
    if (!ids) {
      throw new NuvionError({
        kind: 'validation',
        operation: 'get transfer',
        messages: [`${AREA}: the wallet is not one of Nuvion's`],
      });
    }
    return asTransfer(await this.payouts.getTransfer(ids.entityId, transferId));
  }

  async findByReference(
    holder: AbroadHolder,
    reference: string,
    since: Date | null,
  ): Promise<AbroadLookup> {
    const ids = readNuvionWalletId(holder.walletId);
    if (!ids) return { state: 'unknown' };
    try {
      const found = await this.payouts.findTransferByReference(
        { entityId: ids.entityId, accountId: null },
        reference,
        since ? new Date(since.getTime() - 5 * 60_000) : null,
      );
      if (found.state === 'found') {
        return { state: 'found', transfer: asTransfer(found.transfer) };
      }
      return found.state === 'absent'
        ? { state: 'absent' }
        : { state: 'unknown' };
    } catch (e) {
      if (!(e instanceof WalletProviderError)) throw e;
      if (e.kind === 'auth' || e.kind === 'not_configured') throw e;
      return { state: 'unknown' };
    }
  }

  // -------------------------------------------------------------------------
  // Nuvion's refusals in a person's words
  // -------------------------------------------------------------------------

  /**
   * A refusal a person can act on, or null when the failure is not one (an
   * answer lost, the service down, a key problem): the caller then rethrows
   * the original, which says whether a record may exist. The words are ours;
   * Nuvion's text is never shown.
   */
  refusal(
    e: WalletProviderError,
    during?: 'quote' | 'send',
  ): AbroadRefusal | null {
    const type = e instanceof NuvionError ? e.nuvionType : null;
    if (
      type === 'error_system_dependency_unavailable' ||
      type === 'error_fx_quote_rate_provider_unavailable'
    ) {
      if (during === 'quote') {
        return new AbroadRefusal(
          'rate_unavailable',
          'We cannot get a rate for this pair of currencies right now. Try again later or send from another account.',
        );
      }
      return null;
    }
    if (type === 'error_fx_quote_unsupported_currency_pair') {
      return new AbroadRefusal(
        'corridor_not_supported',
        'We cannot convert between these two currencies yet.',
      );
    }
    if (e.kind === 'insufficient_funds') {
      return new AbroadRefusal(
        'insufficient_funds',
        'There is not enough money in that account for this send.',
      );
    }
    if (
      type !== null &&
      type.startsWith('error_fx_quote') &&
      during === 'send'
    ) {
      return new AbroadRefusal(
        'quote_expired',
        'The rate has changed or was already used. Get a new quote and try again.',
      );
    }
    if (e.kind === 'validation') {
      const fields = complainedFields(e);
      const raw = e.messages.join(' ');
      // Dev says it either as the top-level type (a transfer) or inside the
      // field list under a general one (a quote): "The value 'UGX' is not
      // supported for currency yet".
      if (
        /not supported for (currency|country|scheme|payment_method|to_currency|from_currency)\b/.test(
          raw,
        )
      ) {
        return new AbroadRefusal(
          'corridor_not_supported',
          'We cannot send to that country in that way yet.',
        );
      }
      if (fields.includes('amount')) {
        return new AbroadRefusal(
          'amount_out_of_range',
          'That amount is outside what this corridor takes.',
        );
      }
      if (fields.length > 0) {
        return new AbroadRefusal(
          'invalid_details',
          'The recipient details were not accepted. Check the highlighted fields.',
          { fields },
        );
      }
      if (type === 'error_counterparty_swift_code_invalid') {
        return new AbroadRefusal(
          'invalid_details',
          'The SWIFT or BIC code is not valid.',
          { fields: ['swift_bic'] },
        );
      }
    }
    if (type === 'error_counterparty_swift_code_invalid') {
      return new AbroadRefusal(
        'invalid_details',
        'The SWIFT or BIC code is not valid.',
        { fields: ['swift_bic'] },
      );
    }
    if (
      e.kind === 'refused' ||
      e.kind === 'wallet_inactive' ||
      e.kind === 'payouts_blocked' ||
      e.kind === 'below_minimum'
    ) {
      return new AbroadRefusal(
        'declined',
        'The payment partner did not accept this send. Nothing was taken.',
      );
    }
    return null;
  }
}
