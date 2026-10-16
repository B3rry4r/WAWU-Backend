import { createHash } from 'node:crypto';
import type {
  ProviderAccountName,
  ProviderAccountNameInput,
  ProviderBank,
  ProviderBankTransferInput,
  ProviderHolder,
  ProviderPayee,
  ProviderTransferReceipt,
  WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import { WalletProviderError } from '../../wallet-provider/wallet-provider-error';
import type { NuvionClient, NuvionOp } from '../nuvion-client';
import { maskNuvionText, NuvionError } from '../nuvion-error';
import {
  type NuvionTransferReading,
  readNuvionTransfer,
} from '../nuvion-ledger-delivery';
import {
  isNuvionId,
  NUVION_NAIRA,
  type NuvionAccountReading,
  readNuvionAccount,
} from './accounts';

const AREA = 'payouts (NUV-06)';

/** The country every payout of ours goes to: NIP is Nigeria's rail. */
export const NUVION_NIP_COUNTRY = 'NG';

/**
 * How long Nuvion's bank list is kept in memory before it is asked for
 * again. The money layer keeps its own copy of the same hour (WALLET-14);
 * this one lets a send name the bank without asking Nuvion every time.
 * Default (agent), owner may override.
 */
export const NUVION_BANK_LIST_TTL_MS = 60 * 60_000;

/** A Nigerian account number (NUBAN): ten digits, nothing else. */
const NUBAN = /^\d{10}$/;

/** A bank code as Nuvion's list gives it. */
const BANK_CODE = /^[A-Za-z0-9]{2,12}$/;

/** Our reference goes to Nuvion as `unique_reference`: at most 64 characters. */
const REFERENCE = /^[A-Za-z0-9._:-]{1,64}$/;

/** The longest narration Nuvion takes (api-reference__transfers.md). */
const NARRATION_MAX = 100;

/** The longest account name we hold (a bank's name for an account). */
const NAME_MAX = 200;

/**
 * A counterparty of ours is marked with this key in its `meta` (Nuvion's
 * metadata is free-form strings), so a payee whose creation answer was lost,
 * or whose ids were never kept, is found again instead of made twice.
 */
const PAYEE_META_KEY = 'wawu_payee';

/** Pages of counterparties or payment details read when finding a payee. */
const PAYEE_MAX_PAGES = 20;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function text(o: Record<string, unknown>, key: string): string | null {
  const v = o[key];
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

/**
 * An account holder's name as the bank gave it: one line, single spaces, no
 * control characters. Null when nothing readable is left.
 */
export function cleanAccountName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const t = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ');
  const name = t.trim();
  return name === '' || name.length > NAME_MAX ? null : name;
}

/** One transfer as the payouts area reads it: the shared reading plus what it needs. */
export interface NuvionPayoutReading extends NuvionTransferReading {
  paymentDetailId: string | null;
  /** True when the record carried `applicable_fee` (an absent one is not a charge of 0). */
  feeStated: boolean;
  /** `status_reason`, masked; null when absent. */
  statusReason: string | null;
  /** `meta.source_payment_id`, present on a reversal's credit record. */
  sourcePaymentId: string | null;
}

/** Reads a transfer object (an answer, a delivery's `data`, or a list row). Never throws. */
export function readPayoutTransfer(
  raw: unknown,
): { ok: true; transfer: NuvionPayoutReading } | { ok: false; why: string } {
  const base = readNuvionTransfer(raw);
  if (!base.ok) return base;
  const o = isRecord(raw) && isRecord(raw.transfer) ? raw.transfer : raw;
  const rec = o as Record<string, unknown>;
  const detail = text(rec, 'payment_detail_id');
  const reason = text(rec, 'status_reason');
  const meta = isRecord(rec.meta) ? rec.meta : {};
  const source = text(meta, 'source_payment_id');
  return {
    ok: true,
    transfer: {
      ...base.transfer,
      paymentDetailId: isNuvionId(detail) ? detail : null,
      feeStated:
        rec.applicable_fee !== undefined && rec.applicable_fee !== null,
      statusReason: reason ? maskNuvionText(reason) : null,
      sourcePaymentId: isNuvionId(source) ? source : null,
    },
  };
}

/** The seam's methods this area answers. */
export type NuvionPayoutsMethods = Pick<
  WalletProvider,
  'listBanks' | 'checkAccountName' | 'bankTransfer'
>;

/** Whose transfers: an entity's own, or WAWU's operational account. */
export interface NuvionTransferScope {
  /** The person's entity; null for WAWU's own (parent) entity. */
  entityId: string | null;
  /** One account, when the scope is a single account. */
  accountId: string | null;
}

/** A payee at Nuvion: the counterparty and its bank payment detail. */
interface Payee {
  counterpartyId: string;
  paymentDetailId: string;
}

/** What one send is, for reading Nuvion's answer back against it. */
interface SendContext {
  reference: string;
  amountKobo: number;
  source: { accountId: string; entityId: string | null };
  bank: ProviderBank;
  accountNumber: string;
}

/** The transfer Nuvion holds for a send and the payee it used. */
interface SentTransfer {
  transfer: NuvionPayoutReading;
  payee: Payee;
}

/**
 * Sending to a bank and paying out (task NUV-06): Nuvion's Nigerian bank
 * list (`GET /bank-codes/NG`), the account name check
 * (`POST /counterparty-lookups`, R-39 "facts from Nuvion's own dashboard
 * code"; the public docs list only its `error_resolution_*` errors), and
 * NIP payouts: `POST /counterparties`, `POST /payment-details`
 * (`bank-transfer`, NGN, NG, bank code, account number, holder name) and
 * `POST /transfers` (`payment_type: "bank-transfer"`, our reference as
 * `unique_reference`). The lead's scratchpad
 * `nuvion/docs/guides__send-a-payout.md`, `api-reference__bank-codes.md`,
 * `api-reference__counterparties.md`, `api-reference__payment-details.md`,
 * `api-reference__transfers.md`, `errors.md`. This file is NUV-06's alone.
 *
 * What it keeps to:
 * - A name check sends nothing that moves money, and a person sees the
 *   holder's name before any send (the money layer's rule); not found, bank
 *   not supported, bad format, several matches and a timeout are each their
 *   own answer (`ProviderAccountName.outcome`).
 * - One send is one `unique_reference`. A lost answer is never sent again
 *   from here: it is found again by that reference (src/nuvion/handlers/
 *   outflows-bank.ts) or asked about; and a request that fails before the
 *   transfer is made (the payee could not be set up) says so plainly
 *   (`requestNotSent`, nothing recorded), never as an unknown outcome.
 * - A second send to the same account reuses its counterparty and payment
 *   detail: the caller hands the ids back (`payee`), and failing that a
 *   counterparty carrying our marker is found again.
 * - Every id put in a path is Nuvion's form and percent-encoded; every
 *   figure Nuvion sends is read field by field, whole kobo or refused.
 */
export class NuvionPayoutsArea implements NuvionPayoutsMethods {
  private banks: { at: number; byCode: Map<string, ProviderBank> } | null =
    null;
  private fetching: Promise<Map<string, ProviderBank>> | null = null;

  constructor(
    readonly client: NuvionClient,
    private readonly clock: () => number = Date.now,
  ) {}

  // -------------------------------------------------------------------------
  // The bank list
  // -------------------------------------------------------------------------

  /** Nuvion's Nigerian banks (`GET /bank-codes/NG`), newest asked once an hour. */
  async listBanks(): Promise<ProviderBank[]> {
    return [...(await this.bankMap()).values()];
  }

  private bankMap(): Promise<Map<string, ProviderBank>> {
    if (this.banks && this.clock() - this.banks.at < NUVION_BANK_LIST_TTL_MS) {
      return Promise.resolve(this.banks.byCode);
    }
    // One fetch at a time: sends that arrive together wait for the same
    // answer. A failed fetch is not kept.
    this.fetching ??= this.fetchBanks().finally(() => {
      this.fetching = null;
    });
    return this.fetching;
  }

  private async fetchBanks(): Promise<Map<string, ProviderBank>> {
    const op: NuvionOp = { name: 'list banks', call: 'read' };
    const answer = await this.client.get<unknown>(
      op,
      `/bank-codes/${NUVION_NIP_COUNTRY}`,
    );
    if (!Array.isArray(answer.data)) {
      throw this.unreadable(op, 'the bank list is not a list', answer);
    }
    const byCode = new Map<string, ProviderBank>();
    for (const row of answer.data as unknown[]) {
      if (!isRecord(row)) continue;
      const code = text(row, 'bank_code');
      const name = cleanAccountName(row.bank_name);
      if (!code || !name || !BANK_CODE.test(code)) continue;
      if (!byCode.has(code)) byCode.set(code, { code, name });
    }
    if (byCode.size === 0) {
      // An empty list is never "no banks": nothing is sent against it.
      throw this.unreadable(op, 'the bank list holds no bank', answer);
    }
    this.banks = { at: this.clock(), byCode };
    return byCode;
  }

  // -------------------------------------------------------------------------
  // The account name check
  // -------------------------------------------------------------------------

  /**
   * The holder's name for a ten-digit account at a bank of Nuvion's list
   * (`POST /counterparty-lookups` with `country: "NG"`, the account number
   * and the bank code). Nothing moves and nothing is created. Each way it
   * can end is its own answer (`outcome`), and the first three need no
   * request at all:
   * - `bad_format`: the number is not ten digits, or the code is not shaped
   *   like a bank's;
   * - `bank_not_supported`: the bank is not in Nuvion's list (or Nuvion
   *   says its lookup cannot ask that bank);
   * - `not_found`: Nuvion says no such account;
   * - `multiple_matches`: Nuvion found more than one;
   * - `timeout`: no answer in time, or the lookup service is down.
   * A failure that is not one of these (the key, the rate limit, an
   * unreadable answer) is thrown: the caller says the bank cannot be
   * reached right now.
   */
  async checkAccountName(
    input: ProviderAccountNameInput,
  ): Promise<ProviderAccountName> {
    const op: NuvionOp = { name: 'check account name', call: 'check' };
    const answerOf = (
      outcome: ProviderAccountName['outcome'],
      accountName: string | null = null,
    ): ProviderAccountName => ({
      matched: outcome === 'matched',
      accountName,
      accountNumber: input.accountNumber,
      bankCode: input.bankCode,
      outcome,
    });
    if (!NUBAN.test(input.accountNumber) || !BANK_CODE.test(input.bankCode)) {
      return answerOf('bad_format');
    }
    // The bank must be one Nuvion lists. When the list cannot be read the
    // check is not made (thrown: unavailable), never guessed.
    if (!(await this.bankMap()).has(input.bankCode)) {
      return answerOf('bank_not_supported');
    }
    let data: unknown;
    try {
      const answer = await this.client.post<unknown>(
        op,
        '/counterparty-lookups',
        {
          country: NUVION_NIP_COUNTRY,
          account_number: input.accountNumber,
          bank_code: input.bankCode,
        },
      );
      data = answer.data;
    } catch (e) {
      if (!(e instanceof NuvionError)) throw e;
      switch (e.nuvionType) {
        case 'error_resolution_account_not_found':
          return answerOf('not_found');
        case 'error_resolution_format_invalid':
          return answerOf('bad_format');
        case 'error_resolution_bank_not_supported':
          return answerOf('bank_not_supported');
        case 'error_resolution_multiple_matches':
          return answerOf('multiple_matches');
        case 'error_resolution_timeout':
        case 'error_resolution_service_unavailable':
          return answerOf('timeout');
        default:
      }
      // Our own deadline, or a connection cut: Nuvion said nothing at all.
      if (
        e.kind === 'unavailable' &&
        e.httpStatus === null &&
        !e.requestNotSent
      )
        return answerOf('timeout');
      throw e;
    }
    const lookup = readLookup(data);
    if (!lookup) {
      throw this.unreadable(op, "the answer carries no holder's name", null);
    }
    // An answer for another account is no answer for this one.
    if (
      (lookup.accountNumber !== null &&
        lookup.accountNumber !== input.accountNumber) ||
      (lookup.bankCode !== null && lookup.bankCode !== input.bankCode)
    ) {
      throw this.unreadable(op, 'the answer is for another account', null);
    }
    return answerOf('matched', lookup.accountName);
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  /**
   * One NIP payout from a person's wallet or from WAWU's operational
   * account: the payee (counterparty and payment detail; made once and
   * reused), then `POST /transfers` with our reference as `unique_reference`.
   *
   * Money moves only at the last step, and only under the one reference, so
   * a send tapped twice or at once, or asked again after a lost answer, is
   * one transfer at Nuvion (a repeated reference returns the original). What
   * can fail:
   * - before the transfer: nothing was sent that moves money. A refusal
   *   (validation, the account inactive, the key) is thrown as it is; a
   *   lost answer or a payee that could not be set up is `unavailable` with
   *   `requestNotSent` and `recordMayExist` false, so the send is simply
   *   asked again under the same reference;
   * - the transfer's own failure comes from the client as it is: a refusal
   *   that moved nothing, or `outcome_unknown` (a lost answer, a 5xx, an
   *   answer in flight) that is found again by the reference, never sent
   *   again under a new one;
   * - a transfer that is this very send and that Nuvion's record says
   *   `failed` (a new reference answered so at once, or a repeat's original)
   *   is a failed send of the kind its reason names, `recordMayExist` false;
   *   a repeated reference whose original differs from this send, was
   *   reversed, or (told by a 409) has failed, is `duplicate_reference` (the
   *   reference is used up);
   * - a transfer whose record states no `applicable_fee` is not a receipt
   *   (`not_confirmed`, `recordMayExist` true): a charge is never taken as 0.
   */
  async bankTransfer(
    input: ProviderBankTransferInput,
  ): Promise<ProviderTransferReceipt> {
    const op: NuvionOp = { name: 'bank transfer', call: 'write' };
    const reference = input.reference;
    const refusal = (why: string) =>
      new NuvionError({
        kind: 'validation',
        operation: op.name,
        messages: [`${AREA}: ${why}`],
        reference: REFERENCE.test(reference) ? reference : null,
        recordMayExist: false,
      });
    if (!REFERENCE.test(reference)) {
      throw refusal('the reference is not 1 to 64 plain characters');
    }
    if (typeof input.amountKobo !== 'bigint' || input.amountKobo <= 0n) {
      throw refusal('the amount is not a positive number of kobo');
    }
    const amountKobo = Number(input.amountKobo);
    if (!Number.isSafeInteger(amountKobo)) {
      throw refusal('the amount is beyond what a number holds exactly');
    }
    if (!NUBAN.test(input.accountNumber)) {
      throw refusal('the account number is not ten digits');
    }
    const holderName = cleanAccountName(input.accountName);
    if (holderName === null) {
      throw refusal("the receiving account's name is required");
    }
    const bank = (
      await this.bankMap().catch((e: unknown) => {
        throw this.beforeTransfer(e, op, reference);
      })
    ).get(input.bankCode);
    if (!bank) throw refusal('the bank is not one Nuvion lists');
    const narration =
      input.narration === undefined || input.narration.trim() === ''
        ? undefined
        : input.narration.trim().slice(0, NARRATION_MAX);

    const source = await this.source(op, input.from).catch((e: unknown) => {
      throw this.beforeTransfer(e, op, reference);
    });

    let given = readGivenPayee(input.payee ?? null);
    let payee: Payee;
    try {
      // Ids kept from an earlier send are used only after Nuvion confirms
      // that the payment detail is this very account (a row whose account
      // changed, or ids that belong to another payee, never send money to
      // the wrong place); otherwise the payee is found or made afresh.
      if (
        given !== null &&
        !(await this.payeeIsThisAccount(
          source.entityId,
          given,
          bank,
          input.accountNumber,
        ))
      ) {
        given = null;
      }
      payee =
        given ??
        (await this.payeeFor(source, bank, input.accountNumber, holderName));
    } catch (e) {
      throw this.beforeTransfer(e, op, reference);
    }

    const ctx = {
      reference,
      amountKobo,
      source,
      bank,
      accountNumber: input.accountNumber,
    };
    const send = (p: Payee) => this.postTransfer(op, ctx, p, { narration });
    let sent: SentTransfer;
    try {
      sent = await send(payee);
    } catch (e) {
      // Ids kept from an earlier send that Nuvion no longer knows (a
      // counterparty that was deactivated, say): a 404 on the transfer
      // proves nothing was made, so the payee is found or made afresh and
      // the same reference goes once more.
      if (
        given !== null &&
        e instanceof NuvionError &&
        e.kind === 'not_found' &&
        e.httpStatus === 404
      ) {
        try {
          payee = await this.payeeFor(
            source,
            bank,
            input.accountNumber,
            holderName,
          );
        } catch (e2) {
          throw this.beforeTransfer(e2, op, reference);
        }
        sent = await this.sendOrAdopt(send, payee, ctx);
      } else {
        sent = await this.adoptIfRepeated(e, payee, ctx);
      }
    }
    const transfer = sent.transfer;
    if (!transfer.feeStated) {
      // The transfer exists and Nuvion's record does not say what it
      // charged. A charge is never taken as 0 (as NUV-05's book area): this
      // is not a receipt. Money may have moved, so the send is reconciled by
      // its reference, never sent again; its delivery or a later read says.
      throw new NuvionError({
        kind: 'not_confirmed',
        operation: op.name,
        messages: [
          `${AREA}: the transfer is made, but its record states no fee`,
        ],
        reference,
        recordMayExist: true,
      });
    }
    return {
      ourReference: reference,
      providerReference: transfer.uniqueReference ?? reference,
      secondaryReference: null,
      transactionId: transfer.id,
      amountKobo: BigInt(transfer.amountKobo),
      totalKobo: BigInt(transfer.amountKobo + transfer.feeKobo),
      feeKobo: BigInt(transfer.feeKobo),
      sourceAvailableKobo: null,
      payee: {
        counterpartyId: sent.payee.counterpartyId,
        paymentDetailId: sent.payee.paymentDetailId,
      },
    };
  }

  private sendOrAdopt(
    send: (p: Payee) => Promise<SentTransfer>,
    payee: Payee,
    ctx: SendContext,
  ): Promise<SentTransfer> {
    return send(payee).catch((e: unknown) =>
      this.adoptIfRepeated(e, payee, ctx),
    );
  }

  /**
   * A 409 for a repeated reference means the original exists (Nuvion
   * returns it): find it, and when it is this very send answer it, so a send
   * tapped twice is one transfer. Anything else is thrown as it is.
   */
  private async adoptIfRepeated(
    e: unknown,
    payee: Payee,
    ctx: SendContext,
  ): Promise<SentTransfer> {
    if (!(e instanceof NuvionError) || e.kind !== 'duplicate_reference') {
      throw e;
    }
    let found: NuvionPayoutReading | null = null;
    try {
      const walked = await this.findTransferByReference(
        { entityId: ctx.source.entityId, accountId: ctx.source.accountId },
        ctx.reference,
        null,
      );
      found = walked.state === 'found' ? walked.transfer : null;
    } catch (lookup) {
      if (!(lookup instanceof WalletProviderError)) throw lookup;
    }
    if (found === null) throw e;
    const same = await this.sameSend(found, payee, ctx);
    if (!same.ok) throw e;
    return { transfer: found, payee: same.payee };
  }

  /**
   * Whether a transfer Nuvion holds under our reference is this very send,
   * and the payee it used. A repeated reference returns the original, which
   * may have been made with another counterparty and payment detail (two
   * first sends at once each make their own): it is this send when it is the
   * same amount from the same account, not failed, and its payment detail
   * names this very account.
   */
  private async sameSend(
    t: NuvionPayoutReading,
    asked: Payee,
    ctx: SendContext,
    opts: { allowFailed?: boolean } = {},
  ): Promise<{ ok: true; payee: Payee } | { ok: false; problem: string }> {
    const problem = transferProblem(t, { ...ctx, payee: null }, opts);
    if (problem !== null) return { ok: false, problem };
    const used: Payee = {
      counterpartyId: t.counterpartyId ?? asked.counterpartyId,
      paymentDetailId: t.paymentDetailId ?? asked.paymentDetailId,
    };
    if (
      used.counterpartyId !== asked.counterpartyId ||
      used.paymentDetailId !== asked.paymentDetailId
    ) {
      let named = false;
      try {
        named = await this.payeeIsThisAccount(
          ctx.source.entityId,
          used,
          ctx.bank,
          ctx.accountNumber,
        );
      } catch (e) {
        if (!(e instanceof WalletProviderError)) throw e;
      }
      if (!named) {
        return { ok: false, problem: 'the transfer goes to another account' };
      }
    }
    return { ok: true, payee: used };
  }

  /** `POST /transfers`, the answer read back against what was asked. */
  private async postTransfer(
    op: NuvionOp,
    ctx: SendContext,
    payee: Payee,
    send: { narration?: string },
  ): Promise<SentTransfer> {
    const { source } = ctx;
    const answer = await this.client.post<unknown>(
      op,
      '/transfers',
      {
        account_id: source.accountId,
        payment_detail_id: payee.paymentDetailId,
        counterparty_id: payee.counterpartyId,
        amount: ctx.amountKobo,
        currency: NUVION_NAIRA,
        ...(send.narration === undefined ? {} : { narration: send.narration }),
        payment_type: 'bank-transfer',
        unique_reference: ctx.reference,
        ...(source.entityId === null ? {} : { entity_id: source.entityId }),
      },
      { reference: ctx.reference },
    );
    const read = readPayoutTransfer(answer.data);
    if (!read.ok) {
      // A 2xx without the transfer proves nothing either way.
      throw new NuvionError({
        kind: 'not_confirmed',
        operation: op.name,
        httpStatus: answer.httpStatus,
        messages: [`${AREA}: ${read.why}`],
        reference: ctx.reference,
        recordMayExist: true,
        requestId: answer.requestId,
      });
    }
    const t = read.transfer;
    const same = await this.sameSend(t, payee, ctx, { allowFailed: true });
    if (!same.ok) {
      // The reference names a different send, or one that was reversed: the
      // reference is used up. Money may have moved for whatever it names, so
      // it is reconciled, never charged or sent again.
      throw new NuvionError({
        kind: 'duplicate_reference',
        operation: op.name,
        httpStatus: answer.httpStatus,
        messages: [`${AREA}: ${same.problem}`],
        reference: ctx.reference,
        recordMayExist: true,
        requestId: answer.requestId,
      });
    }
    if (t.status.toLowerCase() === 'failed') {
      // This very send, and Nuvion's own record says it failed (a new
      // reference answered `failed` at once, or the original of a repeat
      // that had failed): it is a failed send, and nothing moved. The
      // reason Nuvion gives names the kind. The reference now names that
      // failed transfer, so a new attempt takes a new reference.
      throw new NuvionError({
        kind: payoutFailureKind(t.statusReason),
        operation: op.name,
        httpStatus: answer.httpStatus,
        messages: [
          `${AREA}: Nuvion reports the transfer failed${t.statusReason ? ` (${t.statusReason})` : ''}`,
        ],
        reference: ctx.reference,
        recordMayExist: false,
        requestId: answer.requestId,
      });
    }
    return { transfer: t, payee: same.payee };
  }

  // -------------------------------------------------------------------------
  // Where the money comes from
  // -------------------------------------------------------------------------

  /**
   * The account a send debits: WAWU's operational account (no entity: it
   * sits under the authenticating entity), or the person's one live naira
   * `checking` account (`GET /accounts?entity_id=`). More than one, or none,
   * is a stop: never a guess at which one money leaves.
   */
  private async source(
    op: NuvionOp,
    from: ProviderHolder,
  ): Promise<{ accountId: string; entityId: string | null }> {
    if (from.kind === 'merchant') {
      const id = this.client.settings.operationalAccountId;
      if (!isNuvionId(id)) {
        throw new NuvionError({
          kind: 'not_configured',
          operation: op.name,
          messages: [
            `${AREA}: the operational account id is not in the form Nuvion uses`,
          ],
        });
      }
      return { accountId: id, entityId: null };
    }
    const entityId = from.customerId;
    if (!isNuvionId(entityId)) {
      throw new NuvionError({
        kind: 'validation',
        operation: op.name,
        messages: [`${AREA}: the customer id is not in the form Nuvion uses`],
      });
    }
    const readOp: NuvionOp = { name: 'find source account', call: 'read' };
    const listed = await this.client.listAll<unknown>(readOp, '/accounts', {
      entity_id: entityId,
      limit: 100,
    });
    if (!listed.complete) {
      throw this.unreadable(
        readOp,
        'the account list is longer than we read',
        null,
      );
    }
    const naira = listed.items
      .map(readNuvionAccount)
      .filter(
        (a): a is NuvionAccountReading =>
          a !== null &&
          !a.deleted &&
          a.currency === NUVION_NAIRA &&
          a.type === 'checking' &&
          (a.entityId === null || a.entityId === entityId),
      );
    if (naira.length !== 1) {
      throw new NuvionError({
        // None: nothing to send from. Two: a stop for a person to look at,
        // never a guess at which one money leaves.
        kind: naira.length === 0 ? 'not_found' : 'refused',
        operation: readOp.name,
        messages: [
          `${AREA}: ${naira.length === 0 ? 'the person has no naira account' : 'the person has more than one naira account'}`,
        ],
      });
    }
    return { accountId: naira[0].id, entityId };
  }

  /** WAWU's operational account's `nuvion_ban`: how WAWU's own side is named in the ledger. */
  async operationalBan(): Promise<string> {
    const op: NuvionOp = { name: 'read operational account', call: 'read' };
    const id = this.client.settings.operationalAccountId;
    if (!isNuvionId(id)) {
      throw new NuvionError({
        kind: 'not_configured',
        operation: op.name,
        messages: [
          `${AREA}: the operational account id is not in the form Nuvion uses`,
        ],
      });
    }
    const answer = await this.client.get<unknown>(
      op,
      `/accounts/${encodeURIComponent(id)}`,
    );
    const account = readNuvionAccount(answer.data);
    if (
      !account ||
      account.id !== id ||
      account.deleted ||
      !account.nuvionBan
    ) {
      throw this.unreadable(
        op,
        'the operational account is not readable',
        answer,
      );
    }
    return account.nuvionBan;
  }

  // -------------------------------------------------------------------------
  // The payee: counterparty and payment detail
  // -------------------------------------------------------------------------

  /**
   * Whether kept payee ids name this account: the payment detail is live,
   * is a naira bank detail of the counterparty given, and carries this
   * account number (and this bank, when it says one).
   */
  private async payeeIsThisAccount(
    entityId: string | null,
    given: Payee,
    bank: ProviderBank,
    accountNumber: string,
  ): Promise<boolean> {
    const op: NuvionOp = { name: 'check kept payee', call: 'read' };
    if (entityId !== null && !isNuvionId(entityId)) return false;
    let answer;
    try {
      answer = await this.client.get<unknown>(
        op,
        `/payment-details/${encodeURIComponent(given.paymentDetailId)}`,
        entityId === null ? undefined : { entity_id: entityId },
      );
    } catch (e) {
      // Nuvion does not know the detail any more: ids to replace. Any other
      // failure is not an answer about it, and is thrown.
      if (e instanceof NuvionError && e.kind === 'not_found') return false;
      throw e;
    }
    const d = answer.data;
    if (!isRecord(d) || text(d, 'id') !== given.paymentDetailId) return false;
    const code = text(d, 'bank_code');
    const counterparty = text(d, 'counterparty_id');
    return (
      text(d, 'payment_method') === 'bank-transfer' &&
      text(d, 'currency')?.toUpperCase() === NUVION_NAIRA &&
      text(d, 'account_number') === accountNumber &&
      (code === null || code === bank.code) &&
      (counterparty === null || counterparty === given.counterpartyId) &&
      (d.deleted === undefined || d.deleted === 0)
    );
  }

  private async payeeFor(
    source: { entityId: string | null },
    bank: ProviderBank,
    accountNumber: string,
    holderName: string,
  ): Promise<Payee> {
    const key = payeeKey(source.entityId, bank.code, accountNumber);
    const counterpartyId =
      (await this.findCounterparty(source.entityId, key)) ??
      (await this.createCounterparty(source.entityId, key, holderName));
    const paymentDetailId =
      (await this.findPaymentDetail(
        source.entityId,
        counterpartyId,
        bank,
        accountNumber,
      )) ??
      (await this.createPaymentDetail(
        source.entityId,
        counterpartyId,
        bank,
        accountNumber,
        holderName,
      ));
    return { counterpartyId, paymentDetailId };
  }

  private async findCounterparty(
    entityId: string | null,
    key: string,
  ): Promise<string | null> {
    const op: NuvionOp = { name: 'find counterparty', call: 'read' };
    const listed = await this.client.listAll<unknown>(
      op,
      '/counterparties',
      {
        ...(entityId === null ? {} : { entity_id: entityId }),
        status: 'active',
        limit: 100,
      },
      { maxPages: PAYEE_MAX_PAGES },
    );
    for (const row of listed.items) {
      if (!isRecord(row)) continue;
      const id = text(row, 'id');
      const meta = isRecord(row.meta) ? row.meta : {};
      const live = row.deleted === undefined || row.deleted === 0;
      const status = text(row, 'status');
      if (
        isNuvionId(id) &&
        live &&
        (status === null || status === 'active') &&
        meta[PAYEE_META_KEY] === key
      ) {
        return id;
      }
    }
    return null;
  }

  private async createCounterparty(
    entityId: string | null,
    key: string,
    holderName: string,
  ): Promise<string> {
    const op: NuvionOp = { name: 'create counterparty', call: 'write' };
    const [first, ...rest] = holderName.split(' ');
    const body = {
      type: 'individual',
      ...(entityId === null ? {} : { entity_id: entityId }),
      profile: {
        first_name: first,
        last_name: rest.length > 0 ? rest.join(' ') : first,
        relationship: 'vendor',
      },
      meta: { [PAYEE_META_KEY]: key },
    };
    try {
      const answer = await this.client.post<unknown>(
        op,
        '/counterparties',
        body,
      );
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
    } catch (e) {
      // A lost answer or "already exists": the counterparty may be there,
      // so it is looked for by our marker and adopted, never made twice.
      if (e instanceof WalletProviderError && e.recordMayExist) {
        const found = await this.findCounterparty(entityId, key);
        if (found !== null) return found;
      }
      throw e;
    }
  }

  private async findPaymentDetail(
    entityId: string | null,
    counterpartyId: string,
    bank: ProviderBank,
    accountNumber: string,
  ): Promise<string | null> {
    const op: NuvionOp = { name: 'find payment detail', call: 'read' };
    const listed = await this.client.listAll<unknown>(
      op,
      `/counterparties/${encodeURIComponent(counterpartyId)}/payment-details`,
      { ...(entityId === null ? {} : { entity_id: entityId }), limit: 100 },
      { maxPages: PAYEE_MAX_PAGES },
    );
    for (const row of listed.items) {
      if (!isRecord(row)) continue;
      const id = text(row, 'id');
      const code = text(row, 'bank_code');
      if (
        isNuvionId(id) &&
        text(row, 'payment_method') === 'bank-transfer' &&
        text(row, 'currency')?.toUpperCase() === NUVION_NAIRA &&
        text(row, 'account_number') === accountNumber &&
        (code === null || code === bank.code) &&
        (row.deleted === undefined || row.deleted === 0)
      ) {
        return id;
      }
    }
    return null;
  }

  private async createPaymentDetail(
    entityId: string | null,
    counterpartyId: string,
    bank: ProviderBank,
    accountNumber: string,
    holderName: string,
  ): Promise<string> {
    const op: NuvionOp = { name: 'create payment detail', call: 'write' };
    const body = {
      payment_method: 'bank-transfer',
      currency: NUVION_NAIRA,
      country: NUVION_NIP_COUNTRY,
      account_holder_name: holderName,
      ...(entityId === null ? {} : { entity_id: entityId }),
      counterparty_id: counterpartyId,
      bank_code: bank.code,
      account_number: accountNumber,
      bank_name: bank.name,
    };
    try {
      const answer = await this.client.post<unknown>(
        op,
        '/payment-details',
        body,
      );
      const id = isRecord(answer.data) ? text(answer.data, 'id') : null;
      if (isNuvionId(id)) return id;
      throw new NuvionError({
        kind: 'not_confirmed',
        operation: op.name,
        httpStatus: answer.httpStatus,
        messages: [`${AREA}: the answer carries no payment detail`],
        recordMayExist: true,
        requestId: answer.requestId,
      });
    } catch (e) {
      if (e instanceof WalletProviderError && e.recordMayExist) {
        const found = await this.findPaymentDetail(
          entityId,
          counterpartyId,
          bank,
          accountNumber,
        );
        if (found !== null) return found;
      }
      throw e;
    }
  }

  // -------------------------------------------------------------------------
  // Reading transfers back (for the handler and the reconciliation)
  // -------------------------------------------------------------------------

  /**
   * `GET /transfers/{id}`: a payout read back before it counts. `entityId`
   * is the person's entity, or null for WAWU's own (the authenticating
   * entity). Answers the transfer as Nuvion sent it, read field by field.
   */
  async getTransfer(
    entityId: string | null,
    transferId: string,
  ): Promise<NuvionPayoutReading> {
    const op: NuvionOp = { name: 'get transfer', call: 'read' };
    if (
      !isNuvionId(transferId) ||
      (entityId !== null && !isNuvionId(entityId))
    ) {
      throw new NuvionError({
        kind: 'validation',
        operation: op.name,
        messages: [`${AREA}: an id is not in the form Nuvion uses`],
      });
    }
    const answer = await this.client.get<unknown>(
      op,
      `/transfers/${encodeURIComponent(transferId)}`,
      entityId === null ? undefined : { entity_id: entityId },
    );
    const read = readPayoutTransfer(answer.data);
    if (!read.ok || read.transfer.id !== transferId) {
      throw this.unreadable(
        op,
        read.ok ? 'the answer is another transfer' : read.why,
        answer,
      );
    }
    return read.transfer;
  }

  /**
   * `GET /payment-details/{id}`: where a payout went, for the ledger's other
   * side. Null when Nuvion cannot say (the ledger row then names no bank).
   */
  async getPaymentDetail(
    entityId: string | null,
    id: string,
  ): Promise<{
    counterpartyId: string | null;
    bankName: string | null;
    bankCode: string | null;
    accountNumber: string | null;
    accountName: string | null;
  } | null> {
    const op: NuvionOp = { name: 'get payment detail', call: 'read' };
    if (!isNuvionId(id) || (entityId !== null && !isNuvionId(entityId))) {
      return null;
    }
    const answer = await this.client.get<unknown>(
      op,
      `/payment-details/${encodeURIComponent(id)}`,
      entityId === null ? undefined : { entity_id: entityId },
    );
    const d = answer.data;
    if (!isRecord(d) || text(d, 'id') !== id) return null;
    return {
      counterpartyId: text(d, 'counterparty_id'),
      bankName: cleanAccountName(d.bank_name),
      bankCode: text(d, 'bank_code'),
      accountNumber: text(d, 'account_number'),
      accountName: cleanAccountName(d.account_holder_name),
    };
  }

  /**
   * The transfer carrying our `unique_reference`, found by walking the
   * scope's transfers (`GET /transfers`), since Nuvion has no lookup by
   * reference. The walk stops at the first match; or at the first row older
   * than `since`, when Nuvion lists newest first (`pagination.order`
   * `desc`); or at the end of the list (complete); or at the page cap
   * (not complete). Only a complete walk can say there is no such transfer.
   */
  async findTransferByReference(
    scope: NuvionTransferScope,
    reference: string,
    since: Date | null,
    opts: { maxPages?: number } = {},
  ): Promise<
    | { state: 'found'; transfer: NuvionPayoutReading }
    | { state: 'absent'; complete: true }
    | { state: 'incomplete' }
  > {
    const op: NuvionOp = { name: 'find transfer by reference', call: 'read' };
    if (
      !REFERENCE.test(reference) ||
      (scope.entityId !== null && !isNuvionId(scope.entityId)) ||
      (scope.accountId !== null && !isNuvionId(scope.accountId))
    ) {
      throw new NuvionError({
        kind: 'validation',
        operation: op.name,
        messages: [`${AREA}: a reference or id is not in the form we send`],
      });
    }
    const maxPages = opts.maxPages ?? 20;
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let pages = 1; ; pages += 1) {
      const page = await this.client.listPage<unknown>(op, '/transfers', {
        ...(scope.entityId === null ? {} : { entity_id: scope.entityId }),
        ...(scope.accountId === null ? {} : { account_id: scope.accountId }),
        limit: 100,
        cursor,
      });
      let reachedBefore = false;
      for (const row of page.items) {
        const read = readPayoutTransfer(row);
        if (!read.ok) continue;
        const t = read.transfer;
        if (t.uniqueReference === reference) {
          return { state: 'found', transfer: t };
        }
        if (
          since !== null &&
          page.pagination.order === 'desc' &&
          t.createdAt !== null &&
          t.createdAt.getTime() < since.getTime()
        ) {
          reachedBefore = true;
        }
      }
      if (reachedBefore || !page.pagination.hasNext) {
        return { state: 'absent', complete: true };
      }
      const next = page.pagination.nextCursor;
      if (next === null || next === cursor || seen.has(next)) {
        throw this.unreadable(
          op,
          'a page says more follow but gives no new cursor',
          null,
        );
      }
      if (pages >= maxPages) return { state: 'incomplete' };
      seen.add(next);
      cursor = next;
    }
  }

  // -------------------------------------------------------------------------
  // Failures
  // -------------------------------------------------------------------------

  /**
   * A failure before the transfer was made. Nothing that moves money has
   * been sent, so it is never an unknown outcome: a refusal stays the
   * refusal it is; a lost answer, a partial creation or an unreadable answer
   * becomes `unavailable` with `requestNotSent`, so the send is asked again
   * under the same reference.
   */
  private beforeTransfer(e: unknown, op: NuvionOp, reference: string): Error {
    if (!(e instanceof WalletProviderError)) {
      return e instanceof Error
        ? e
        : new Error('a send failed before the transfer');
    }
    switch (e.kind) {
      case 'outcome_unknown':
      case 'not_confirmed':
      case 'duplicate_reference':
      case 'unavailable':
      case 'bad_response':
        return new NuvionError({
          kind: 'unavailable',
          operation: op.name,
          httpStatus: e.httpStatus,
          messages: [
            `${AREA}: the payee could not be set up; no transfer was made`,
          ],
          reference,
          recordMayExist: false,
          requestNotSent: true,
          retryAfterSeconds: e.retryAfterSeconds,
        });
      default:
        return e;
    }
  }

  private unreadable(
    op: NuvionOp,
    why: string,
    answer: { httpStatus: number; requestId: string | null } | null,
  ): NuvionError {
    return new NuvionError({
      kind: op.call === 'write' ? 'not_confirmed' : 'bad_response',
      operation: op.name,
      httpStatus: answer?.httpStatus ?? null,
      messages: [`${AREA}: ${why}`],
      requestId: answer?.requestId ?? null,
    });
  }
}

/** The payee ids a caller kept, when both are Nuvion's form. */
function readGivenPayee(p: ProviderPayee | null): Payee | null {
  if (p && isNuvionId(p.counterpartyId) && isNuvionId(p.paymentDetailId)) {
    return {
      counterpartyId: p.counterpartyId,
      paymentDetailId: p.paymentDetailId,
    };
  }
  return null;
}

/** A stable marker for one payee of one sender: no account number in clear. */
export function payeeKey(
  entityId: string | null,
  bankCode: string,
  accountNumber: string,
): string {
  return createHash('sha256')
    .update(`${entityId ?? 'wawu'}|${bankCode}|${accountNumber}`)
    .digest('hex')
    .slice(0, 40);
}

/**
 * Why a transfer Nuvion answered is not this send, or null when it is. A
 * repeated `unique_reference` returns the original, so the original must be
 * the same send: our reference, the same amount in naira, a bank transfer
 * from our account to the same payee, and not already failed.
 */
export function transferProblem(
  t: NuvionPayoutReading,
  expect: {
    reference: string;
    amountKobo: number;
    source: { accountId: string; entityId: string | null };
    /** Null: the payee is judged by the caller (a repeated reference's original). */
    payee: Payee | null;
  },
  /**
   * `allowFailed`: the status `failed` is not a problem (the caller reads it
   * and says the send failed). `reversed` always is: money went and came
   * back, and the reference is used up.
   */
  opts: { allowFailed?: boolean } = {},
): string | null {
  if (t.uniqueReference !== null && t.uniqueReference !== expect.reference) {
    return 'the transfer carries another reference';
  }
  if (t.amountKobo !== expect.amountKobo) {
    return `the reference names a transfer of ${t.amountKobo} kobo, not ${expect.amountKobo}`;
  }
  if (t.currency !== NUVION_NAIRA) return `the transfer is in ${t.currency}`;
  if (t.type !== null && t.type !== 'outflow') {
    return 'the transfer is not money out';
  }
  if (t.paymentType !== null && t.paymentType !== 'bank-transfer') {
    return 'the transfer is not a bank transfer';
  }
  if (t.accountId !== null && t.accountId !== expect.source.accountId) {
    return 'the transfer leaves another account';
  }
  if (
    expect.source.entityId !== null &&
    t.entityId !== null &&
    t.entityId !== expect.source.entityId
  ) {
    return 'the transfer is for another entity';
  }
  if (
    expect.payee !== null &&
    t.counterpartyId !== null &&
    t.counterpartyId !== expect.payee.counterpartyId
  ) {
    return 'the transfer goes to another payee';
  }
  if (
    expect.payee !== null &&
    t.paymentDetailId !== null &&
    t.paymentDetailId !== expect.payee.paymentDetailId
  ) {
    return 'the transfer goes to another account';
  }
  const status = t.status.toLowerCase();
  if (
    (status === 'failed' && opts.allowFailed !== true) ||
    status === 'reversed'
  ) {
    return `the transfer has already ${status === 'failed' ? 'failed' : 'been reversed'}`;
  }
  return null;
}

/**
 * What a send that Nuvion's own record says `failed` is, as the seam's kind
 * (the same reading NUV-05 gives a failed book transfer): its
 * `status_reason` names the cause, and anything it does not name is a plain
 * refusal.
 */
export function payoutFailureKind(
  reason: string | null,
): 'insufficient_funds' | 'wallet_inactive' | 'refused' {
  const r = (reason ?? '').toLowerCase();
  if (r.includes('insufficient')) return 'insufficient_funds';
  if (
    r.includes('not_active') ||
    r.includes('frozen') ||
    r.includes('inactive')
  ) {
    return 'wallet_inactive';
  }
  return 'refused';
}

/** The holder, the number and the bank a lookup answered, field by field. */
function readLookup(data: unknown): {
  accountName: string;
  accountNumber: string | null;
  bankCode: string | null;
} | null {
  const o = isRecord(data) && isRecord(data.account) ? data.account : data;
  if (!isRecord(o)) return null;
  const name =
    cleanAccountName(o.account_holder_name) ??
    cleanAccountName(o.account_name) ??
    cleanAccountName(o.holder_name);
  if (name === null) return null;
  return {
    accountName: name,
    accountNumber: text(o, 'account_number'),
    bankCode: text(o, 'bank_code'),
  };
}
