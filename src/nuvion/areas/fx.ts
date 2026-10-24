import {
  chainOfNetwork,
  FX_CHAIN_NETWORK,
  FX_CURRENCIES,
  fxCurrency,
  fxCurrencyOfNuvion,
} from '../../money/fx/fx-currencies';
import type {
  ProviderForeignAccounts,
  ProviderFxAccount,
  ProviderFxChain,
  ProviderFxDetails,
  ProviderFxOpened,
  ProviderFxPerson,
  ProviderFxQuote,
  ProviderFxQuoteInput,
  ProviderFxSendInput,
  ProviderFxSide,
  ProviderFxStatementLine,
  ProviderFxStatementPage,
  ProviderFxSwapInput,
  ProviderFxTransfer,
  ProviderFxTransferLookup,
} from '../../wallet-provider/wallet-provider-fx';
import { WalletProviderError } from '../../wallet-provider/wallet-provider-error';
import type { NuvionClient, NuvionOp } from '../nuvion-client';
import { readNuvionTransfer } from '../nuvion-ledger-delivery';
import { maskNuvionText, NuvionError } from '../nuvion-error';
import { isNuvionId, readNuvionAccount, readNuvionWalletId } from './accounts';

const AREA = 'foreign accounts (WALLET-21)';
const NARRATION_MAX = 100;
const PAYEE_META_KEY = 'wawu_fx_payee';
/** Pages of counterparties or transfers read when looking for one of ours. */
const LOOKUP_PAGES = 5;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function text(o: Record<string, unknown>, key: string): string | null {
  const v = o[key];
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}
function whole(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) ? v : null;
}

/** The decimal text of a rate Nuvion sent as a number (never `1e-7`). */
export function rateText(rate: unknown): string | null {
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
    return null;
  }
  const t = rate.toFixed(12).replace(/0+$/, '').replace(/\.$/, '');
  return t === '' ? null : t;
}

/**
 * Foreign-currency accounts on Nuvion (task WALLET-21, R-83, R-84):
 * accounts in USD, EUR, GBP, CAD, AED and GHS and the stablecoins USDT
 * (`UST`), USDC (`USC`) and RLUSD (`RLD`), their details, FX quotes, swaps
 * as book transfers carrying `fx_quote_id`, stablecoin sends and statements.
 * Facts are the lead's scratchpad `nuvion-docs/` pages named in the task and
 * Nuvion's dev answers of 24 Oct 2026 (mobile `docs/nuvion/DEV-RESULTS.md`):
 *
 * - One account holds one set of details, so a stablecoin on two chains is
 *   two accounts (dev: a second chain on one account answers 409
 *   `error_duplicate_resource`).
 * - A book transfer that converts has `currency` the SOURCE account's and
 *   `amount` the quote's `amount_from` (FIX-98); the receiving account is
 *   named by its `nuvion_ban`.
 * - A stablecoin send needs a counterparty and a `stablecoin-transfer`
 *   payment detail (`blockchain_network` ETH_MAINNET ..., `wallet_address`,
 *   `account_holder_name`).
 * Every id put in a path is checked to be Nuvion's form. This file is
 * WALLET-21's alone; the seam adapter (nuvion-wallet-provider.ts) hands it
 * `fx`.
 */
export class NuvionFxArea implements ProviderForeignAccounts {
  readonly currencies = FX_CURRENCIES.map((c) => c.code);

  constructor(readonly client: NuvionClient) {}

  // -------------------------------------------------------------------------
  // Accounts and their details
  // -------------------------------------------------------------------------

  async openAccount(input: {
    person: ProviderFxPerson;
    currency: string;
    chain: ProviderFxChain | null;
    displayName: string;
    holderName: string;
  }): Promise<ProviderFxOpened> {
    const op: NuvionOp = { name: 'open foreign account', call: 'write' };
    const def = this.def(op, input.currency);
    const entityId = this.entity(op, input.person);
    // A stablecoin account's wallet is bound to one chain for good, so the
    // chain is checked before an account is made that could not be given it.
    if (def.kind === 'stablecoin') {
      if (!input.chain || !def.chains.includes(input.chain)) {
        throw this.fail(
          op,
          'validation',
          'a stablecoin account needs a chain it can be held on',
        );
      }
    } else if (input.chain) {
      throw this.fail(op, 'validation', 'a bank currency has no chain');
    }
    const answer = await this.client.post<unknown>(op, '/accounts', {
      entity_id: entityId,
      type: 'checking',
      currency: def.nuvion,
      display_name: input.displayName.slice(0, 100),
    });
    const account = this.accountOf(op, answer, entityId, def.nuvion);
    let details: ProviderFxDetails | null = null;
    try {
      details = await this.readDetails(
        input.person,
        {
          accountId: account.accountId,
          currency: input.currency,
          chain: input.chain,
        },
        true,
      );
    } catch (e) {
      // The account exists; its details come on a later read (dev: CAD and
      // AED answered 503 for the details on 24 Oct). Only an answer that says
      // the account cannot have them is passed on.
      if (!(e instanceof WalletProviderError) || e.kind === 'refused') {
        throw e;
      }
    }
    return { account, details };
  }

  async readAccount(
    person: ProviderFxPerson,
    accountId: string,
  ): Promise<ProviderFxAccount> {
    const op: NuvionOp = { name: 'read foreign account', call: 'read' };
    const entityId = this.entity(op, person);
    this.id(op, accountId);
    const answer = await this.client.get<unknown>(
      op,
      `/accounts/${encodeURIComponent(accountId)}`,
      { entity_id: entityId },
    );
    const read = readNuvionAccount(answer.data);
    if (!read || read.id !== accountId) {
      throw this.bad(op, 'the answer is not this account', answer);
    }
    if (read.deleted) {
      throw this.fail(op, 'not_found', 'the account is deleted', answer);
    }
    const def = read.currency ? fxCurrencyOfNuvion(read.currency) : null;
    if (!def)
      throw this.bad(op, 'the account is in a currency we do not hold', answer);
    return this.accountFrom(op, read, def.code, answer);
  }

  async readDetails(
    person: ProviderFxPerson,
    account: {
      accountId: string;
      currency: string;
      chain: ProviderFxChain | null;
    },
    ensure: boolean,
  ): Promise<ProviderFxDetails | null> {
    const op: NuvionOp = { name: 'read foreign account details', call: 'read' };
    const def = this.def(op, account.currency);
    const entityId = this.entity(op, person);
    this.id(op, account.accountId);
    let found = await this.findDetails(op, entityId, account.accountId);
    if (!found && ensure) {
      const wop: NuvionOp = {
        name: 'create foreign account details',
        call: 'write',
      };
      const body: Record<string, unknown> = {
        account_id: account.accountId,
        entity_id: entityId,
      };
      if (def.kind === 'stablecoin') {
        if (!account.chain || !def.chains.includes(account.chain)) {
          throw this.fail(
            wop,
            'validation',
            'a stablecoin account needs a chain it can be held on',
          );
        }
        body.chain = account.chain;
      }
      try {
        await this.client.post<unknown>(wop, '/account-details', body);
      } catch (e) {
        // Not issued now (dev: 503) or already there (409): read what exists.
        if (!(e instanceof WalletProviderError)) throw e;
        if (e.kind === 'refused' || e.kind === 'validation') throw e;
      }
      found = await this.findDetails(op, entityId, account.accountId);
    }
    return found ? this.detailsFrom(found) : null;
  }

  private async findDetails(
    op: NuvionOp,
    entityId: string,
    accountId: string,
  ): Promise<Record<string, unknown> | null> {
    const listed = await this.client.listAll<unknown>(op, '/account-details', {
      account_id: accountId,
      entity_id: entityId,
      limit: 100,
    });
    if (!listed.complete)
      throw this.bad(op, 'the account details list is longer than we read');
    const live = listed.items.filter(
      (d): d is Record<string, unknown> =>
        isRecord(d) &&
        text(d, 'account_id') === accountId &&
        (d.deleted === undefined || d.deleted === 0),
    );
    if (live.length > 1)
      throw this.bad(op, 'the account has more than one set of details');
    return live[0] ?? null;
  }

  private detailsFrom(d: Record<string, unknown>): ProviderFxDetails {
    const issuer = isRecord(d.issuer) ? d.issuer : {};
    const meta = isRecord(issuer.meta) ? issuer.meta : {};
    const stable = text(d, 'asset_type')?.toLowerCase() === 'stablecoin';
    const status =
      text(d, 'status')?.toLowerCase() === 'active' ? 'active' : 'pending';
    const scheme = text(issuer, 'scheme');
    return {
      detailsId: text(d, 'id') ?? '',
      status,
      beneficiaryName: text(d, 'beneficiary_name'),
      accountNumber: stable ? null : text(d, 'account_number'),
      routingNumber: text(d, 'routing_number') ?? text(meta, 'routing_number'),
      swiftCode: text(meta, 'swift_code'),
      iban: text(d, 'iban'),
      sortCode:
        text(meta, 'sort_code') ??
        (scheme === 'sort_code' ? text(issuer, 'code') : null),
      bankName:
        text(meta, 'bank_name') ?? (stable ? null : text(issuer, 'name')),
      bankAddress: text(meta, 'bank_address'),
      chain: stable
        ? ((text(d, 'chain') as ProviderFxChain | null) ??
          chainOfNetwork(text(issuer, 'code')))
        : null,
      address: stable ? text(d, 'account_number') : null,
    };
  }

  // -------------------------------------------------------------------------
  // Quote, swap, send
  // -------------------------------------------------------------------------

  async quote(input: ProviderFxQuoteInput): Promise<ProviderFxQuote> {
    const op: NuvionOp = { name: 'create fx quote', call: 'read' };
    const entityId = this.entity(op, input.person);
    const from = this.side(op, input.person, input.from);
    const to = this.side(op, input.person, input.to);
    if (
      (input.amountFromMinor === undefined) ===
      (input.amountToMinor === undefined)
    ) {
      throw this.fail(op, 'validation', 'exactly one of the two amounts');
    }
    const body: Record<string, unknown> = {
      from_currency: from.currency,
      to_currency: to.currency,
      account_id: from.accountId,
      entity_id: entityId,
    };
    if (input.amountFromMinor !== undefined) {
      body.amount_from = Number(input.amountFromMinor);
    } else {
      body.amount_to = Number(input.amountToMinor);
    }
    // A quote is a request that makes no money move, but it is a POST: a
    // lost answer is simply asked again.
    const answer = await this.client.post<unknown>(op, '/fx-quotes', body);
    const d = answer.data;
    if (!isRecord(d)) throw this.bad(op, 'the answer is not a quote', answer);
    const q = isRecord(d.quote) ? d.quote : {};
    const id = text(d, 'id');
    const amountFrom = whole(d.amount_from);
    const amountTo = whole(d.amount_to);
    const rate = rateText(d.rate);
    const expires = whole(q.expires_at);
    if (
      !isNuvionId(id) ||
      amountFrom === null ||
      amountTo === null ||
      rate === null ||
      expires === null ||
      amountFrom <= 0 ||
      amountTo <= 0
    ) {
      throw this.bad(
        op,
        'the quote is missing its id, amounts, rate or expiry',
        answer,
      );
    }
    if (text(d, 'from') !== from.currency || text(d, 'to') !== to.currency) {
      throw this.bad(op, 'the quote is for another pair', answer);
    }
    return {
      id,
      amountFromMinor: BigInt(amountFrom),
      amountToMinor: BigInt(amountTo),
      rate,
      expiresAt: new Date(expires),
      // Nuvion's quote carries no fee (api-reference__fx-quotes.md).
      feeMinor: null,
    };
  }

  async swap(input: ProviderFxSwapInput): Promise<ProviderFxTransfer> {
    const op: NuvionOp = { name: 'swap between accounts', call: 'write' };
    const entityId = this.entity(op, input.person);
    if (input.quoteId !== null) this.id(op, input.quoteId);
    const from = this.side(op, input.person, input.from);
    const to = await this.receiver(op, input.person, input.to);
    const body = {
      account_id: from.accountId,
      amount: Number(input.amountFromMinor),
      // The source account's currency (FIX-98): the quote's `from`.
      currency: from.currency,
      payment_type: 'book-transfer',
      nuvion_ban: to,
      narration: (input.narration ?? 'WAWU swap').slice(0, NARRATION_MAX),
      unique_reference: input.reference,
      ...(input.quoteId === null ? {} : { fx_quote_id: input.quoteId }),
      entity_id: entityId,
    };
    return this.transfer(op, body, input.reference, entityId, from.accountId);
  }

  async send(input: ProviderFxSendInput): Promise<ProviderFxTransfer> {
    const op: NuvionOp = { name: 'send stablecoin', call: 'write' };
    const def = this.def(op, input.currency);
    const entityId = this.entity(op, input.person);
    this.id(op, input.accountId);
    if (def.kind !== 'stablecoin') {
      throw this.fail(
        op,
        'not_supported',
        'only a stablecoin is sent to an address',
      );
    }
    const payee = await this.payee(op, entityId, input);
    const body = {
      account_id: input.accountId,
      payment_detail_id: payee.paymentDetailId,
      counterparty_id: payee.counterpartyId,
      amount: Number(input.amountMinor),
      currency: def.nuvion,
      narration: 'WAWU send',
      payment_type: 'stablecoin-transfer',
      unique_reference: input.reference,
      entity_id: entityId,
    };
    return this.transfer(op, body, input.reference, entityId, input.accountId);
  }

  async findTransferByReference(
    person: ProviderFxPerson,
    accountId: string,
    reference: string,
  ): Promise<ProviderFxTransferLookup> {
    const op: NuvionOp = { name: 'find foreign transfer', call: 'read' };
    const entityId = this.entity(op, person);
    this.id(op, accountId);
    const listed = await this.client.listAll<unknown>(
      op,
      '/transfers',
      { entity_id: entityId, account_id: accountId, limit: 100 },
      { maxPages: LOOKUP_PAGES },
    );
    for (const row of listed.items) {
      const t = this.transferFrom(row, reference);
      if (t && isRecord(row) && text(row, 'unique_reference') === reference) {
        return { state: 'found', transfer: t };
      }
    }
    // Only a complete list is proof that there is none.
    return listed.complete ? { state: 'absent' } : { state: 'unknown' };
  }

  async readTransfer(
    person: ProviderFxPerson,
    transferId: string,
  ): Promise<ProviderFxTransferLookup> {
    const op: NuvionOp = { name: 'read foreign transfer', call: 'read' };
    const entityId = this.entity(op, person);
    this.id(op, transferId);
    try {
      const answer = await this.client.get<unknown>(
        op,
        `/transfers/${encodeURIComponent(transferId)}`,
        { entity_id: entityId },
      );
      const t = this.transferFrom(answer.data, null);
      return t ? { state: 'found', transfer: t } : { state: 'unknown' };
    } catch (e) {
      if (e instanceof WalletProviderError && e.kind === 'not_found') {
        return { state: 'absent' };
      }
      throw e;
    }
  }

  /** Sends one transfer and answers what Nuvion holds, finding the original of a repeated reference. */
  private async transfer(
    op: NuvionOp,
    body: Record<string, unknown>,
    reference: string,
    entityId: string,
    accountId: string,
  ): Promise<ProviderFxTransfer> {
    try {
      const answer = await this.client.post<unknown>(op, '/transfers', body, {
        reference,
      });
      const t = this.transferFrom(answer.data, reference);
      if (!t) {
        throw new NuvionError({
          kind: 'not_confirmed',
          operation: op.name,
          httpStatus: answer.httpStatus,
          messages: [`${AREA}: the answer is not a transfer`],
          reference,
          recordMayExist: true,
          requestId: answer.requestId,
        });
      }
      return t;
    } catch (e) {
      if (
        e instanceof WalletProviderError &&
        e.kind === 'duplicate_reference'
      ) {
        const found = await this.findByReference(
          entityId,
          accountId,
          reference,
        );
        if (found) return found;
      }
      throw e;
    }
  }

  private transferFrom(
    raw: unknown,
    reference: string | null,
  ): ProviderFxTransfer | null {
    const read = readNuvionTransfer(raw);
    if (!read.ok) return null;
    const t = read.transfer;
    if (
      reference !== null &&
      t.uniqueReference !== null &&
      t.uniqueReference !== reference
    ) {
      return null;
    }
    const o = isRecord(raw) ? raw : {};
    const status = t.status.toLowerCase();
    const reason = text(o, 'status_reason');
    return {
      transferId: t.id,
      reference: t.uniqueReference ?? reference ?? '',
      status:
        status === 'successful'
          ? 'completed'
          : status === 'failed' || status === 'reversed'
            ? 'failed'
            : 'pending',
      feeMinor: BigInt(t.feeKobo),
      failureReason:
        status === 'failed' || status === 'reversed'
          ? reason
            ? maskNuvionText(reason)
            : 'The provider did not complete it.'
          : null,
    };
  }

  private async findByReference(
    entityId: string,
    accountId: string,
    reference: string,
  ): Promise<ProviderFxTransfer | null> {
    const op: NuvionOp = { name: 'find foreign transfer', call: 'read' };
    const listed = await this.client.listAll<unknown>(
      op,
      '/transfers',
      { entity_id: entityId, account_id: accountId, limit: 100 },
      { maxPages: LOOKUP_PAGES },
    );
    for (const row of listed.items) {
      const t = this.transferFrom(row, reference);
      if (t && isRecord(row) && text(row, 'unique_reference') === reference)
        return t;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // The payee of a stablecoin send
  // -------------------------------------------------------------------------

  private async payee(
    op: NuvionOp,
    entityId: string,
    input: ProviderFxSendInput,
  ): Promise<{ counterpartyId: string; paymentDetailId: string }> {
    const def = this.def(op, input.currency);
    const network = FX_CHAIN_NETWORK[input.chain];
    const key = `${def.nuvion}:${network}:${input.address.toLowerCase()}`;
    let counterpartyId = await this.findCounterparty(entityId, key);
    if (!counterpartyId) {
      counterpartyId = await this.createCounterparty(
        entityId,
        key,
        input.holderName,
      );
    }
    let paymentDetailId = await this.findPaymentDetail(
      entityId,
      counterpartyId,
      def.nuvion,
      network,
      input.address,
    );
    if (!paymentDetailId) {
      const cop: NuvionOp = {
        name: 'create stablecoin payment detail',
        call: 'write',
      };
      const answer = await this.client.post<unknown>(cop, '/payment-details', {
        payment_method: 'stablecoin-transfer',
        currency: def.nuvion,
        entity_id: entityId,
        counterparty_id: counterpartyId,
        blockchain_network: network,
        wallet_address: input.address,
        account_holder_name: input.holderName,
      });
      const id = isRecord(answer.data) ? text(answer.data, 'id') : null;
      if (!isNuvionId(id))
        throw this.bad(cop, 'the answer carries no payment detail', answer);
      paymentDetailId = id;
    }
    return { counterpartyId, paymentDetailId };
  }

  private async findCounterparty(
    entityId: string,
    key: string,
  ): Promise<string | null> {
    const op: NuvionOp = { name: 'find stablecoin payee', call: 'read' };
    const listed = await this.client.listAll<unknown>(
      op,
      '/counterparties',
      { entity_id: entityId, status: 'active', limit: 100 },
      { maxPages: LOOKUP_PAGES },
    );
    for (const row of listed.items) {
      if (!isRecord(row)) continue;
      const meta = isRecord(row.meta) ? row.meta : {};
      const id = text(row, 'id');
      if (
        isNuvionId(id) &&
        meta[PAYEE_META_KEY] === key &&
        (row.deleted === undefined || row.deleted === 0)
      ) {
        return id;
      }
    }
    return null;
  }

  private async createCounterparty(
    entityId: string,
    key: string,
    holderName: string,
  ): Promise<string> {
    const op: NuvionOp = { name: 'create stablecoin payee', call: 'write' };
    // An individual's counterparty carries the sender's own email and address
    // (dev, FIX-97 and FIX-98); none is made up.
    const eop: NuvionOp = { name: 'read sender contact', call: 'read' };
    const entity = await this.client.get<unknown>(
      eop,
      `/entities/${encodeURIComponent(entityId)}`,
    );
    const d = isRecord(entity.data) ? entity.data : {};
    const person = isRecord(d.person) ? d.person : {};
    const address = isRecord(d.address) ? d.address : {};
    const email = text(person, 'email');
    const line1 = text(address, 'line_1');
    const city = text(address, 'city');
    const state = text(address, 'state');
    const postal = text(address, 'postal_code');
    const country = text(address, 'country_code');
    if (!email || !line1 || !city || !state || !postal || !country) {
      throw this.fail(
        op,
        'refused',
        'the sender has no email or address on file for a payee',
      );
    }
    const [first, ...rest] = holderName.split(' ');
    const answer = await this.client.post<unknown>(op, '/counterparties', {
      type: 'individual',
      entity_id: entityId,
      profile: {
        first_name: first,
        last_name: rest.length > 0 ? rest.join(' ') : first,
        relationship: 'vendor',
        email,
        address: {
          line1,
          city,
          state_or_province: state,
          postal_code: postal,
          country,
        },
      },
      meta: { [PAYEE_META_KEY]: key },
    });
    const id = isRecord(answer.data) ? text(answer.data, 'id') : null;
    if (!isNuvionId(id))
      throw this.bad(op, 'the answer carries no counterparty', answer);
    return id;
  }

  private async findPaymentDetail(
    entityId: string,
    counterpartyId: string,
    nuvionCurrency: string,
    network: string,
    address: string,
  ): Promise<string | null> {
    const op: NuvionOp = {
      name: 'find stablecoin payment detail',
      call: 'read',
    };
    const listed = await this.client.listAll<unknown>(
      op,
      `/counterparties/${encodeURIComponent(counterpartyId)}/payment-details`,
      { entity_id: entityId, limit: 100 },
      { maxPages: LOOKUP_PAGES },
    );
    for (const row of listed.items) {
      if (!isRecord(row)) continue;
      const id = text(row, 'id');
      if (
        isNuvionId(id) &&
        text(row, 'payment_method') === 'stablecoin-transfer' &&
        text(row, 'currency') === nuvionCurrency &&
        text(row, 'blockchain_network') === network &&
        text(row, 'wallet_address')?.toLowerCase() === address.toLowerCase()
      ) {
        return id;
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Statements
  // -------------------------------------------------------------------------

  async statement(
    person: ProviderFxPerson,
    account: { accountId: string; currency: string },
    query: {
      year: number;
      month: number;
      cursor: string | null;
      limit: number;
    },
  ): Promise<ProviderFxStatementPage> {
    const op: NuvionOp = { name: 'foreign account statement', call: 'read' };
    const entityId = this.entity(op, person);
    this.id(op, account.accountId);
    const page = await this.client.statementPage<unknown>(
      op,
      `/accounts/${encodeURIComponent(account.accountId)}/statements`,
      {
        year: query.year,
        month: query.month,
        limit: query.limit,
        include_pending: true,
        entity_id: entityId,
        ...(query.cursor ? { cursor: query.cursor } : {}),
      },
    );
    const lines: ProviderFxStatementLine[] = [];
    for (const raw of page.items) {
      const line = this.lineFrom(raw);
      if (line) lines.push(line);
    }
    return {
      lines,
      nextCursor: page.pagination.hasNext ? page.pagination.nextCursor : null,
    };
  }

  private lineFrom(raw: unknown): ProviderFxStatementLine | null {
    if (!isRecord(raw)) return null;
    const id = text(raw, 'transaction_id');
    const amount = whole(raw.amount);
    const date = text(raw, 'date');
    if (!id || amount === null || amount < 0 || !date) return null;
    const type = text(raw, 'type');
    const status = text(raw, 'status')?.toLowerCase() ?? '';
    const fee = whole(raw.fee) ?? 0;
    const running = whole(raw.running_balance);
    const cp = isRecord(raw.counterparty) ? raw.counterparty : {};
    const fx = isRecord(raw.fx) ? raw.fx : null;
    const rate = fx ? rateText(fx.rate) : null;
    const fromMinor = fx ? whole(fx.source_amount) : null;
    const toMinor = fx ? whole(fx.destination_amount) : null;
    const conv =
      fx && rate && fromMinor !== null && toMinor !== null
        ? {
            fromCurrency: this.wawuCode(text(fx, 'source_currency')),
            toCurrency: this.wawuCode(text(fx, 'destination_currency')),
            rate,
            fromMinor: BigInt(fromMinor),
            toMinor: BigInt(toMinor),
          }
        : null;
    return {
      id,
      direction: type === 'credit' ? 'in' : 'out',
      status:
        status === 'completed' || status === 'successful'
          ? 'completed'
          : status === 'failed'
            ? 'failed'
            : status === 'reversed'
              ? 'reversed'
              : 'pending',
      amountMinor: BigInt(amount),
      feeMinor: BigInt(fee),
      balanceAfterMinor:
        running !== null && running >= 0 ? BigInt(running) : null,
      description: maskNuvionText(text(raw, 'description') ?? ''),
      counterpartyName: text(cp, 'name'),
      reference: text(raw, 'reference') ?? '',
      occurredAt: new Date(date).toISOString(),
      conversion: conv,
    };
  }

  private wawuCode(nuvion: string | null): string {
    if (!nuvion) return '';
    if (nuvion.toUpperCase() === 'NGN') return 'NGN';
    return fxCurrencyOfNuvion(nuvion)?.code ?? nuvion.toUpperCase();
  }

  // -------------------------------------------------------------------------
  // Ids and shapes
  // -------------------------------------------------------------------------

  private def(op: NuvionOp, code: string) {
    const def = fxCurrency(code);
    if (!def)
      throw this.fail(op, 'validation', `${code} is not a currency we hold`);
    return def;
  }

  private entity(op: NuvionOp, person: ProviderFxPerson): string {
    if (!isNuvionId(person.customerId)) {
      throw this.fail(op, 'validation', 'an id is not in the form Nuvion uses');
    }
    return person.customerId;
  }

  private id(op: NuvionOp, id: string): void {
    if (!isNuvionId(id))
      throw this.fail(op, 'validation', 'an id is not in the form Nuvion uses');
  }

  /** A side as Nuvion names it: its currency code and the account debited or quoted on. */
  private side(
    op: NuvionOp,
    person: ProviderFxPerson,
    side: ProviderFxSide,
  ): { currency: string; accountId: string } {
    if (side.currency === 'NGN') {
      const ids = readNuvionWalletId(person.walletId);
      if (!ids || ids.entityId !== person.customerId) {
        throw this.fail(
          op,
          'validation',
          "the naira wallet is not this person's",
        );
      }
      return { currency: 'NGN', accountId: ids.accountId };
    }
    const def = this.def(op, side.currency);
    if (!side.accountId)
      throw this.fail(op, 'validation', 'a foreign side needs its account');
    this.id(op, side.accountId);
    return { currency: def.nuvion, accountId: side.accountId };
  }

  /** The `nuvion_ban` a book transfer is routed on: the side's own, or the naira wallet's, read. */
  private async receiver(
    op: NuvionOp,
    person: ProviderFxPerson,
    side: ProviderFxSide,
  ): Promise<string> {
    if (side.currency !== 'NGN') {
      if (!side.ban)
        throw this.fail(
          op,
          'validation',
          'the receiving account has no routing number',
        );
      return side.ban;
    }
    const to = this.side(op, person, side);
    const answer = await this.client.get<unknown>(
      { name: 'read naira routing', call: 'read' },
      `/accounts/${encodeURIComponent(to.accountId)}`,
      { entity_id: person.customerId },
    );
    const read = readNuvionAccount(answer.data);
    if (!read?.nuvionBan)
      throw this.bad(op, 'the naira account has no routing number', answer);
    return read.nuvionBan;
  }

  private accountOf(
    op: NuvionOp,
    answer: { data: unknown; httpStatus: number; requestId: string | null },
    entityId: string,
    nuvionCurrency: string,
  ): ProviderFxAccount {
    const data = answer.data;
    const read = readNuvionAccount(
      isRecord(data) && isRecord(data.account) ? data.account : data,
    );
    if (
      !read ||
      (read.entityId !== null && read.entityId !== entityId) ||
      read.currency !== nuvionCurrency
    ) {
      throw new NuvionError({
        kind: 'not_confirmed',
        operation: op.name,
        httpStatus: answer.httpStatus,
        messages: [`${AREA}: the answer is not the account we asked for`],
        recordMayExist: true,
        requestId: answer.requestId,
      });
    }
    const def = fxCurrencyOfNuvion(nuvionCurrency)!;
    return this.accountFrom(op, read, def.code, answer);
  }

  private accountFrom(
    op: NuvionOp,
    read: NonNullable<ReturnType<typeof readNuvionAccount>>,
    code: string,
    answer: { httpStatus: number; requestId: string | null },
  ): ProviderFxAccount {
    if (
      read.available === null ||
      read.available < 0 ||
      read.current === null ||
      read.current < 0
    ) {
      throw this.bad(
        op,
        'the balance is not a whole number at or above 0',
        answer,
      );
    }
    return {
      accountId: read.id,
      currency: code,
      ban: read.nuvionBan,
      availableMinor: BigInt(read.available),
      bookedMinor: BigInt(read.current),
    };
  }

  private fail(
    op: NuvionOp,
    kind: 'validation' | 'refused' | 'not_found' | 'not_supported',
    why: string,
    answer?: { httpStatus: number; requestId: string | null },
  ) {
    return new NuvionError({
      kind,
      operation: op.name,
      httpStatus: answer?.httpStatus ?? null,
      messages: [`${AREA}: ${why}`],
      requestId: answer?.requestId ?? null,
    });
  }

  private bad(
    op: NuvionOp,
    why: string,
    answer?: { httpStatus: number; requestId: string | null },
  ) {
    return new NuvionError({
      kind: 'bad_response',
      operation: op.name,
      httpStatus: answer?.httpStatus ?? null,
      messages: [`${AREA}: ${why}`],
      requestId: answer?.requestId ?? null,
    });
  }
}
