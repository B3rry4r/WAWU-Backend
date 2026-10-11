import type {
  ProviderHolder,
  ProviderLookup,
  ProviderMovementConfirmation,
  ProviderPlatformAccount,
  ProviderReconciliation,
  ProviderTransaction,
  ProviderTransferReceipt,
  ProviderWalletTransferInput,
  WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import { WalletProviderError } from '../../wallet-provider/wallet-provider-error';
import type { NuvionClient, NuvionOp } from '../nuvion-client';
import type { NuvionSettings } from '../nuvion-config';
import type { NuvionListQuery } from '../nuvion.interface';
import { maskNuvionText, NuvionError } from '../nuvion-error';
import {
  nuvionTransferStatus,
  type NuvionTransferReading,
  readNuvionTransfer,
} from '../nuvion-ledger-delivery';
import { isNuvionId, NUVION_NAIRA, readNuvionAccount } from './accounts';
import {
  type BookAccountRef,
  isBookNuvionStatus,
  type BookTransferRow,
  type NuvionBookStore,
} from './book-store';

const AREA = 'book transfers (NUV-05)';

/** Nuvion's payment type for a move between two Nuvion accounts. */
export const NUVION_BOOK_TRANSFER = 'book-transfer';

/** `unique_reference`: at most 64 characters (api-reference__transfers.md). */
export const NUVION_MAX_REFERENCE = 64;
/** `narration`: at most 100 characters (api-reference__transfers.md). */
export const NUVION_MAX_NARRATION = 100;
/** What a transfer is described as when the caller gave no words. */
export const NUVION_DEFAULT_NARRATION = 'WAWU transfer';

/**
 * What WAWU's own account at Nuvion may look like before money is sent to
 * it: letters and digits only, 6 to 34 of them (the same rule MerchantWallet
 * applies to the account it is handed), so a garbled answer never becomes
 * the receiver of a payment.
 */
const NUVION_BAN = /^[A-Za-z0-9]{6,34}$/;

/**
 * PROVISIONAL(NUVION-BOOK-SETTLE-WAIT, owner=YOU, why=Nuvion answers a transfer pending first and its docs say a book transfer is instant but give no time; a few short reads after the answer turn most into a completed payment inside the request, and a slower one is pending until its delivery or the sweep says)
 *
 * How long, in milliseconds, a book transfer Nuvion accepted and has not
 * finished is read again, one wait after another, before the answer is
 * given as "accepted, not finished" (the seam's `not_confirmed`). The total
 * is under four seconds; nothing is sent again meanwhile.
 */
export const NUVION_BOOK_SETTLE_STEPS_MS: readonly number[] = [
  250, 500, 1000, 1250,
];

/** The history of a sender is read this many rows a page, for at most this many pages. */
const HISTORY_LIMIT = 100;
const HISTORY_MAX_PAGES = 20;
/** A transfer is looked for from a little before the time it was sent. */
const HISTORY_MARGIN_MS = 10 * 60_000;

/** The WalletProvider methods this area answers for the adapter. */
export type NuvionBookMethods = Required<
  Pick<
    WalletProvider,
    | 'getPlatformAccount'
    | 'walletToWallet'
    | 'isSameAccount'
    | 'findTransactionByReference'
    | 'findTransactionById'
    | 'reconcileSend'
    | 'decideRetry'
    | 'confirmMovement'
    | 'secondaryReferenceOf'
  >
>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** One transfer as the book area reads it: the shared reading plus what it needs. */
export interface BookTransferReading extends NuvionTransferReading {
  /** `status_reason`, masked; null when absent. */
  statusReason: string | null;
  /** True when the record carried `applicable_fee` (an absent one is not a charge of 0). */
  feeStated: boolean;
  /** `meta.source_payment_id`, present on a reversal's credit record. */
  sourcePaymentId: string | null;
}

/** Reads a transfer object (the answer of `POST` or `GET /transfers/{id}`, or a list row). Never throws. */
export function readBookTransfer(
  raw: unknown,
): { ok: true; transfer: BookTransferReading } | { ok: false; why: string } {
  const base = readNuvionTransfer(raw);
  if (!base.ok) return base;
  const o = isRecord(raw) && isRecord(raw.transfer) ? raw.transfer : raw;
  const rec = o as Record<string, unknown>;
  const reason =
    typeof rec.status_reason === 'string' && rec.status_reason.trim() !== ''
      ? maskNuvionText(rec.status_reason.trim())
      : null;
  const meta = isRecord(rec.meta) ? rec.meta : {};
  const source =
    typeof meta.source_payment_id === 'string' &&
    isNuvionId(meta.source_payment_id)
      ? meta.source_payment_id
      : null;
  return {
    ok: true,
    transfer: {
      ...base.transfer,
      statusReason: reason,
      feeStated:
        rec.applicable_fee !== undefined && rec.applicable_fee !== null,
      sourcePaymentId: source,
    },
  };
}

/** Whether Nuvion has not finished with a transfer yet. */
export function isUnfinished(status: string): boolean {
  return status === 'pending' || status === 'processing';
}

/**
 * Why Nuvion's record of a transfer is not the transfer the log says we
 * sent, or null when it is. Field by field: the account debited, the
 * amount, the currency, the rail, the direction, our reference, the id.
 * `requireReference`: a record that names no reference of ours is accepted
 * only for the answer to our own request.
 */
export function bookTransferProblem(
  row: Pick<
    BookTransferRow,
    'reference' | 'nuvionId' | 'fromAccountId' | 'fromEntityId' | 'amountKobo'
  >,
  t: BookTransferReading,
  opts: { requireReference: boolean } = { requireReference: false },
): string | null {
  if (row.nuvionId !== null && t.id !== row.nuvionId) {
    return 'Nuvion answered another transfer';
  }
  if (t.accountId !== row.fromAccountId) {
    return 'the transfer debits another account';
  }
  if (
    t.entityId !== null &&
    row.fromEntityId !== null &&
    t.entityId !== row.fromEntityId
  ) {
    return 'the transfer is for another entity';
  }
  if (BigInt(t.amountKobo) !== row.amountKobo) {
    return `Nuvion's record says ${t.amountKobo} kobo, the transfer we sent was ${row.amountKobo}`;
  }
  if (t.currency !== NUVION_NAIRA) {
    return `the transfer is in ${t.currency}, not naira`;
  }
  if (t.paymentType !== NUVION_BOOK_TRANSFER) {
    return `the transfer is a ${t.paymentType ?? 'transfer of no named rail'}, not a book transfer`;
  }
  if (t.type !== null && t.type !== 'outflow') {
    return 'the transfer is not an outflow';
  }
  if (t.uniqueReference !== null) {
    if (t.uniqueReference !== row.reference) {
      return 'the transfer carries another reference than ours';
    }
  } else if (opts.requireReference) {
    return 'the transfer names no reference of ours';
  }
  return null;
}

/** A Nuvion record as the seam's transaction. */
export function bookTransactionOf(
  t: BookTransferReading,
  fallbackCreatedAt: Date,
): ProviderTransaction {
  return {
    id: t.id,
    createdAt: (t.createdAt ?? fallbackCreatedAt).toISOString(),
    amountKobo: BigInt(t.amountKobo),
    status: t.status,
    outcome: nuvionTransferStatus(t.status),
    ourReference: t.uniqueReference,
    providerReference: t.id,
    // Nuvion has one reference for a transfer, its id.
    secondaryReference: null,
    sessionId: null,
    // The fee Nuvion took, when its record says (an absent one is not 0).
    feeKobo: t.feeStated ? BigInt(t.feeKobo) : null,
  };
}

function requestNotSent(e: WalletProviderError): boolean {
  return (e as { requestNotSent?: unknown }).requestNotSent === true;
}

/** What `status_reason` of a failed transfer says, as a seam kind. */
function failureKind(
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

/**
 * Paying from the wallet and held money (task NUV-05): book transfers on
 * Nuvion's own rail (`POST /transfers`, `payment_type: "book-transfer"`, the
 * receiving account's `nuvion_ban`, our reference as `unique_reference`),
 * and WAWU's operational account (NUVION_OPERATIONAL_ACCOUNT_ID, R-42),
 * which replaces Fintava's merchant wallet for held money. The lead's
 * scratchpad `nuvion/docs/guides__send-a-payout.md`,
 * `api-reference__transfers.md`, `core-concepts__accounts.md`. This file is
 * NUV-05's alone.
 *
 * **What the seam asks and what this answers** (SHARED-CHANGES MONEY-17 #1,
 * lead rulings of MONEY-17 round 5 and 6, as the stand-in the services were
 * checked against, `test/payments/nuvion-seam-standin.ts`, models them):
 * - `walletToWallet` resolves with a receipt only for a transfer Nuvion
 *   reports `successful`. One it accepted and has not finished is
 *   `not_confirmed`, a lost answer `outcome_unknown`, a repeated reference
 *   the original's state: each may have moved money (`recordMayExist`), so
 *   the caller keeps the payment pending and asks again, never sends again
 *   and never refunds. Nuvion answers `pending` first ("all transfers are
 *   asynchronous"), so the transfer is read again a few times before the
 *   answer is given (NUVION_BOOK_SETTLE_STEPS_MS).
 * - One reference is one transfer: the log (`NuvionBookTransfer`) refuses a
 *   reference for other accounts or another amount, and Nuvion's own
 *   idempotency on `unique_reference` returns the original for a repeat. A
 *   lost answer is never "sent again under a new reference": the log row
 *   holds the sender and the time, and the transfer is found by walking the
 *   sender's transfers (`GET /transfers?entity_id=&account_id=`, each item
 *   carries its `unique_reference`). Nuvion has no lookup by our reference.
 * - Silence is never proof that no money moved: absent stays a wait
 *   (`decideRetry` never advises a resend), as for every Nuvion send.
 * - The sender and the receiver are named to the seam by the number WAWU's
 *   records hold (a person's account number, WAWU's `nuvion_ban`); this
 *   area turns them into Nuvion's ids from WAWU's records, and a name it
 *   cannot place sends nothing.
 * - Amounts and fees are Nuvion's: `applicable_fee` is read from its
 *   record, never computed here.
 */
export class NuvionBookArea implements NuvionBookMethods {
  private operational: {
    accountId: string;
    nuvionBan: string;
    entityId: string | null;
  } | null = null;

  constructor(
    readonly client: NuvionClient,
    readonly settings: Pick<NuvionSettings, 'operationalAccountId'> &
      Partial<Pick<NuvionSettings, 'moneyTimeoutMs'>>,
    readonly store?: NuvionBookStore,
    private readonly options: {
      /** The waits between reads of a transfer Nuvion has not finished. */
      settleStepsMs?: readonly number[];
      /** Rows a page of a sender's history is asked for, and pages read at most (specs). */
      historyLimit?: number;
      historyMaxPages?: number;
      sleep?: (ms: number) => Promise<void>;
      now?: () => Date;
    } = {},
  ) {}

  // -------------------------------------------------------------------------
  // WAWU's own account
  // -------------------------------------------------------------------------

  /**
   * WAWU's operational account: its `nuvion_ban` (what a book transfer
   * names it by) and its balance, read from Nuvion on every call
   * (`GET /accounts/{id}`), never cached and never a sum of our rows.
   */
  async getPlatformAccount(): Promise<ProviderPlatformAccount> {
    const op: NuvionOp = { name: 'get platform account', call: 'read' };
    const a = await this.readOperational(op);
    return {
      accountNumber: a.nuvionBan,
      accountName: a.displayName ?? 'WAWU',
      availableKobo: BigInt(a.available),
      bookedKobo: BigInt(a.current),
    };
  }

  private async readOperational(op: NuvionOp): Promise<{
    accountId: string;
    entityId: string | null;
    nuvionBan: string;
    displayName: string | null;
    available: number;
    current: number;
  }> {
    const id = this.settings.operationalAccountId;
    if (!isNuvionId(id)) {
      throw this.error('not_configured', op.name, [
        `${AREA}: the operational account id is not in the form Nuvion uses`,
      ]);
    }
    const answer = await this.client.get<unknown>(
      op,
      `/accounts/${encodeURIComponent(id)}`,
    );
    const account = readNuvionAccount(answer.data);
    const fail = (why: string) =>
      new NuvionError({
        kind: 'bad_response',
        operation: op.name,
        httpStatus: answer.httpStatus,
        messages: [`${AREA}: ${why}`],
        requestId: answer.requestId,
      });
    if (!account) throw fail('the answer carries no account');
    if (account.id !== id) throw fail('the answer is for another account');
    if (account.deleted) {
      throw new NuvionError({
        kind: 'merchant_inactive',
        operation: op.name,
        httpStatus: answer.httpStatus,
        messages: [`${AREA}: the operational account is deleted`],
        requestId: answer.requestId,
      });
    }
    if (account.type !== 'operational') {
      throw fail(
        `the configured account is a ${account.type ?? 'typeless'} account, not WAWU's operational account`,
      );
    }
    if (account.currency !== NUVION_NAIRA) {
      throw fail(`the account is in ${account.currency ?? 'no currency'}`);
    }
    if (!account.nuvionBan || !NUVION_BAN.test(account.nuvionBan)) {
      throw fail('the account has no usable nuvion_ban');
    }
    if (account.available === null || account.available < 0) {
      throw fail('the available balance is not a whole number of kobo');
    }
    if (account.current === null || account.current < 0) {
      throw fail('the current balance is not a whole number of kobo');
    }
    const raw = isRecord(answer.data) ? answer.data : {};
    const obj = isRecord(raw.account) ? raw.account : raw;
    const name =
      typeof obj.display_name === 'string' && obj.display_name.trim() !== ''
        ? obj.display_name.trim().slice(0, 100)
        : null;
    this.operational = {
      accountId: account.id,
      nuvionBan: account.nuvionBan,
      entityId: account.entityId,
    };
    return {
      accountId: account.id,
      entityId: account.entityId,
      nuvionBan: account.nuvionBan,
      displayName: name,
      available: account.available,
      current: account.current,
    };
  }

  private async operationalIdentity(): Promise<{
    accountId: string;
    nuvionBan: string;
    entityId: string | null;
  }> {
    if (this.operational) return this.operational;
    await this.readOperational({ name: 'get platform account', call: 'read' });
    return this.operational!;
  }

  // -------------------------------------------------------------------------
  // Which account a name is
  // -------------------------------------------------------------------------

  /**
   * The Nuvion account a name from WAWU's records stands for: a person's
   * account number (or id, or `nuvion_ban`, any case), or WAWU's operational
   * account by its `nuvion_ban` or id. Null when it is neither.
   */
  private async resolve(
    name: string,
    op: NuvionOp,
  ): Promise<BookAccountRef | null> {
    const n = name.trim();
    if (n === '' || n.length > 130) return null;
    const person = await this.need(op).findPersonAccount(n);
    if (person === 'ambiguous') {
      throw this.error('validation', op.name, [
        `${AREA}: a name matches more than one account; nothing was sent`,
      ]);
    }
    if (person) {
      const ban =
        person.nuvionBan ??
        (await this.nuvionBanOf(person.entityId, person.accountId));
      return {
        accountId: person.accountId,
        entityId: person.entityId,
        accountNumber: person.accountNumber ?? n,
        nuvionBan: ban,
        operational: false,
      };
    }
    const op_ = await this.operationalIdentity();
    if (
      n === op_.accountId ||
      n.toLowerCase() === op_.nuvionBan.toLowerCase()
    ) {
      return {
        accountId: op_.accountId,
        entityId: null,
        accountNumber: op_.nuvionBan,
        nuvionBan: op_.nuvionBan,
        operational: true,
      };
    }
    return null;
  }

  /** A person's `nuvion_ban` read from Nuvion, when our records hold none. */
  private async nuvionBanOf(
    entityId: string,
    accountId: string,
  ): Promise<string> {
    const op: NuvionOp = { name: 'get account', call: 'read' };
    const answer = await this.client.get<unknown>(
      op,
      `/accounts/${encodeURIComponent(accountId)}`,
      { entity_id: entityId },
    );
    const a = readNuvionAccount(answer.data);
    if (
      !a ||
      a.id !== accountId ||
      a.deleted ||
      a.currency !== NUVION_NAIRA ||
      !a.nuvionBan ||
      !NUVION_BAN.test(a.nuvionBan)
    ) {
      throw new NuvionError({
        kind: 'bad_response',
        operation: op.name,
        httpStatus: answer.httpStatus,
        messages: [`${AREA}: the account has no usable nuvion_ban`],
        requestId: answer.requestId,
      });
    }
    return a.nuvionBan;
  }

  /**
   * Whether two names are one account at Nuvion (lead ruling R5-1): a
   * person's account number, its id and its `nuvion_ban` (any case) name one
   * account; WAWU's operational account is named by its `nuvion_ban` or its
   * id. Never moves money; fails with a `WalletProviderError` when Nuvion
   * cannot be asked for WAWU's own account.
   */
  async isSameAccount(a: string, b: string): Promise<boolean> {
    const x = a.trim();
    const y = b.trim();
    if (x === '' || y === '') return false;
    if (x.toLowerCase() === y.toLowerCase()) return true;
    const op: NuvionOp = { name: 'same account', call: 'read' };
    const [ra, rb] = [await this.resolve(x, op), await this.resolve(y, op)];
    return ra !== null && rb !== null && ra.accountId === rb.accountId;
  }

  // -------------------------------------------------------------------------
  // Moving money
  // -------------------------------------------------------------------------

  async walletToWallet(
    input: ProviderWalletTransferInput,
  ): Promise<ProviderTransferReceipt> {
    const op: NuvionOp = { name: 'book transfer', call: 'write' };
    const reference = input.reference.trim();
    const narration =
      (input.narration ?? '').trim() || NUVION_DEFAULT_NARRATION;
    this.checkSend(op, input, reference);
    const store = this.need(op);

    const from = await this.resolve(input.fromAccountNumber, op);
    const to = await this.resolve(input.toAccountNumber, op);
    if (!from || !to) {
      throw this.error(
        'not_found',
        op.name,
        [
          `${AREA}: ${!from ? 'the sending' : 'the receiving'} account is not one of WAWU's Nuvion accounts; nothing was sent`,
        ],
        reference,
      );
    }
    if (from.accountId === to.accountId) {
      throw this.error(
        'validation',
        op.name,
        [`${AREA}: a transfer from an account to itself; nothing was sent`],
        reference,
      );
    }

    const now = this.now();
    const begun = await store.begin(
      {
        reference,
        from,
        to,
        amountKobo: input.amountKobo,
        narration: narration.slice(0, NUVION_MAX_NARRATION),
      },
      now,
    );
    let row = begun.row;
    if (!begun.created) {
      if (
        row.fromAccountId !== from.accountId ||
        row.toAccountId !== to.accountId ||
        row.amountKobo !== input.amountKobo
      ) {
        // The reference is in the log for another transfer: never sent for
        // this one. A person looks (the services treat it as unknown).
        throw this.error(
          'duplicate_reference',
          op.name,
          [
            `${AREA}: this reference was used for another transfer; nothing was sent`,
          ],
          reference,
          true,
        );
      }
      if (row.status === 'refused') row = await store.reopen(reference, now);
      // Its answer was read before: Nuvion is asked about it, not told again.
      if (row.nuvionId) return this.answerFromRecord(row, op);
    }
    return this.send(row, op);
  }

  /** Sends the transfer (or finds the original of a repeated reference) and answers. */
  private async send(
    row: BookTransferRow,
    op: NuvionOp,
  ): Promise<ProviderTransferReceipt> {
    const body: Record<string, unknown> = {
      account_id: row.fromAccountId,
      amount: Number(row.amountKobo),
      currency: NUVION_NAIRA,
      payment_type: NUVION_BOOK_TRANSFER,
      // The receiver, by the number Nuvion routes a book transfer on.
      nuvion_ban: row.toNuvionBan,
      narration: row.narration ?? NUVION_DEFAULT_NARRATION,
      unique_reference: row.reference,
    };
    // A person's transfers name their entity; WAWU's operational account is
    // the authenticating entity's own, which omits it.
    if (row.fromEntityId !== null) body.entity_id = row.fromEntityId;

    let answer: { data: unknown; httpStatus: number; requestId: string | null };
    try {
      answer = await this.client.post<unknown>(op, '/transfers', body, {
        reference: row.reference,
      });
    } catch (e) {
      return this.afterFailedSend(row, op, e);
    }
    const read = readBookTransfer(answer.data);
    if (!read.ok) {
      // A 2xx that is not a transfer: not proof either way. The row stays
      // `sending`; the transfer is found by its reference later.
      throw new NuvionError({
        kind: 'not_confirmed',
        operation: op.name,
        httpStatus: answer.httpStatus,
        messages: [`${AREA}: the answer is not a transfer (${read.why})`],
        reference: row.reference,
        recordMayExist: true,
        requestId: answer.requestId,
      });
    }
    return this.afterAnswer(row, read.transfer, op, answer);
  }

  /** A send that failed: what it proves, and what the log says. */
  private async afterFailedSend(
    row: BookTransferRow,
    op: NuvionOp,
    e: unknown,
  ): Promise<ProviderTransferReceipt> {
    if (!(e instanceof WalletProviderError)) throw e;
    const store = this.need(op);
    if (e.kind === 'duplicate_reference') {
      // Nuvion has a transfer under this reference: the original is read and
      // answered, never a second one made. If it cannot be found, the error
      // stands (unknown, asked about later).
      const found = await this.findOriginal(row).catch(() => null);
      if (found) return this.afterAnswer(row, found, op, null);
      throw e;
    }
    if (requestNotSent(e)) {
      // The connection never opened: Nuvion has no record of this request.
      await store.markRefused(
        row.reference,
        'nothing reached Nuvion',
        this.now(),
      );
      throw e;
    }
    if (!e.recordMayExist) {
      // Nuvion answered that it made nothing: the reference is not used up.
      await store.markRefused(row.reference, `refused (${e.kind})`, this.now());
    }
    throw e;
  }

  /** The state of the transfer Nuvion holds, as the seam's answer. */
  private async afterAnswer(
    row: BookTransferRow,
    first: BookTransferReading,
    op: NuvionOp,
    answered: { httpStatus: number; requestId: string | null } | null,
  ): Promise<ProviderTransferReceipt> {
    const problem = bookTransferProblem(row, first, {
      requireReference: false,
    });
    if (problem) {
      // Nuvion's record is not the transfer we sent. The id is not kept.
      throw new NuvionError({
        kind: 'not_confirmed',
        operation: op.name,
        httpStatus: answered?.httpStatus ?? null,
        messages: [`${AREA}: ${problem}; kept for review`],
        reference: row.reference,
        recordMayExist: true,
        requestId: answered?.requestId ?? null,
      });
    }
    let t = first;
    let kept = await this.keep(row, t, true);
    if (isUnfinished(t.status)) {
      const later = await this.settleWait(kept, t);
      if (later) {
        t = later;
        kept = (await this.keep(kept, t, false)) ?? kept;
      }
    }
    return this.translate(kept, t, op, answered?.requestId ?? null);
  }

  /** The log row after Nuvion's record was read into it. */
  private async keep(
    row: BookTransferRow,
    t: BookTransferReading,
    answered: boolean,
  ): Promise<BookTransferRow> {
    if (!isBookNuvionStatus(t.status)) return row;
    const updated = await this.need().recordRead(
      row.reference,
      {
        nuvionId: t.id,
        status: t.status,
        statusReason: t.statusReason,
        feeKobo: t.feeStated ? BigInt(t.feeKobo) : null,
      },
      this.now(),
      { answered },
    );
    return updated ?? row;
  }

  /** Reads the transfer again while Nuvion has not finished it, within the wait. */
  private async settleWait(
    row: BookTransferRow,
    first: BookTransferReading,
  ): Promise<BookTransferReading | null> {
    const steps = this.options.settleStepsMs ?? NUVION_BOOK_SETTLE_STEPS_MS;
    let latest: BookTransferReading | null = null;
    let current = first;
    for (const wait of steps) {
      if (!isUnfinished(current.status)) break;
      await this.sleep(wait);
      try {
        current = await this.readOf(row, current.id);
        latest = current;
      } catch {
        // Nuvion could not be read: the transfer stays unfinished here, and
        // is asked about again by the payment's sweep.
        break;
      }
    }
    return latest;
  }

  /** The seam's answer for the transfer's state. */
  private translate(
    row: BookTransferRow,
    t: BookTransferReading,
    op: NuvionOp,
    requestId: string | null,
  ): ProviderTransferReceipt {
    const outcome = nuvionTransferStatus(t.status);
    const base = {
      operation: op.name,
      reference: row.reference,
      requestId,
    };
    if (outcome === 'completed') {
      if (!t.feeStated) {
        // Done, but Nuvion's record does not say what it charged: not a
        // figure to complete a payment at. Pending until a read says.
        throw new NuvionError({
          kind: 'not_confirmed',
          ...base,
          messages: [
            `${AREA}: the transfer is done, but its record states no fee`,
          ],
          recordMayExist: true,
        });
      }
      const amount = BigInt(t.amountKobo);
      const fee = BigInt(t.feeKobo);
      return {
        ourReference: row.reference,
        providerReference: t.id,
        secondaryReference: null,
        transactionId: t.id,
        amountKobo: amount,
        totalKobo: amount + fee,
        feeKobo: fee,
        // Nuvion's transfer object carries no balance.
        sourceAvailableKobo: null,
      };
    }
    if (outcome === 'failed') {
      throw new NuvionError({
        kind: failureKind(t.statusReason),
        ...base,
        httpStatus: 200,
        messages: [
          `${AREA}: Nuvion reports the transfer failed${t.statusReason ? ` (${t.statusReason})` : ''}`,
        ],
        // Nuvion's own record says it failed: nothing moved.
        recordMayExist: false,
      });
    }
    // Pending, processing, reversed, or a word we do not know: money may
    // have moved or may still move. Never a failure, never sent again.
    throw new NuvionError({
      kind: 'not_confirmed',
      ...base,
      messages: [
        outcome === 'reversed'
          ? `${AREA}: Nuvion reports the transfer was reversed`
          : outcome === 'pending'
            ? `${AREA}: Nuvion accepted the transfer and has not finished it`
            : `${AREA}: Nuvion's status "${t.status}" is not one we know`,
      ],
      recordMayExist: true,
    });
  }

  /** A transfer whose answer was read before: its record decides, nothing is sent. */
  private async answerFromRecord(
    row: BookTransferRow,
    op: NuvionOp,
  ): Promise<ProviderTransferReceipt> {
    let t: BookTransferReading;
    try {
      t = await this.readOf(row, row.nuvionId!);
    } catch (e) {
      // Nuvion cannot be read: the money may have moved, so this is an
      // unknown outcome and never a refusal or a second send.
      if (e instanceof WalletProviderError) {
        throw new NuvionError({
          kind: 'outcome_unknown',
          operation: op.name,
          messages: [
            `${AREA}: the transfer could not be read back (${e.kind})`,
          ],
          reference: row.reference,
          recordMayExist: true,
        });
      }
      throw e;
    }
    const kept = (await this.keep(row, t, false)) ?? row;
    return this.translate(kept, t, op, null);
  }

  // -------------------------------------------------------------------------
  // Reading one transfer
  // -------------------------------------------------------------------------

  /**
   * `GET /transfers/{id}` for a transfer the log holds, checked against the
   * row: the same transfer, from the same account, for the same amount, in
   * naira, on the book rail, with our reference. Fails with `bad_response`
   * (a read) when Nuvion's record is another transfer.
   */
  async readOf(row: BookTransferRow, id: string): Promise<BookTransferReading> {
    const op: NuvionOp = { name: 'get transfer', call: 'read' };
    if (!isNuvionId(id)) {
      throw this.error('validation', op.name, [
        `${AREA}: an id is not in the form Nuvion uses`,
      ]);
    }
    const answer = await this.client.get<unknown>(
      op,
      `/transfers/${encodeURIComponent(id)}`,
      row.fromEntityId === null ? undefined : { entity_id: row.fromEntityId },
    );
    const read = readBookTransfer(answer.data);
    if (!read.ok) {
      throw new NuvionError({
        kind: 'bad_response',
        operation: op.name,
        httpStatus: answer.httpStatus,
        messages: [`${AREA}: ${read.why}`],
        requestId: answer.requestId,
      });
    }
    const problem =
      read.transfer.id !== id
        ? 'Nuvion answered another transfer'
        : bookTransferProblem({ ...row, nuvionId: id }, read.transfer);
    if (problem) {
      throw new NuvionError({
        kind: 'bad_response',
        operation: op.name,
        httpStatus: answer.httpStatus,
        messages: [`${AREA}: ${problem}`],
        requestId: answer.requestId,
      });
    }
    return read.transfer;
  }

  /**
   * The transfer Nuvion holds under a log row's reference, found without its
   * id: the sender's transfers newest first, each carrying its
   * `unique_reference`. Null when the walk found none.
   */
  private async findOriginal(
    row: BookTransferRow,
  ): Promise<BookTransferReading | null> {
    const walk = await this.walk(
      { accountId: row.fromAccountId, entityId: row.fromEntityId },
      row.reference,
      new Date(row.sentAt.getTime() - HISTORY_MARGIN_MS),
    );
    if (walk.state !== 'found') return null;
    const problem = bookTransferProblem(row, walk.transfer, {
      requireReference: true,
    });
    return problem ? null : walk.transfer;
  }

  /**
   * Walks a sender's transfers newest first looking for one reference. Stops
   * at the end of the list, once a page is older than `since` (only when
   * Nuvion says the list is newest first), or at the page cap, and says
   * which: a walk that stopped at the cap proves nothing about absence.
   */
  private async walk(
    sender: { accountId: string | null; entityId: string | null },
    reference: string,
    since: Date | null,
  ): Promise<
    | { state: 'found'; transfer: BookTransferReading }
    | { state: 'not_found'; complete: boolean }
  > {
    const op: NuvionOp = { name: 'list transfers', call: 'read' };
    let cursor: string | undefined;
    const maxPages = this.options.historyMaxPages ?? HISTORY_MAX_PAGES;
    for (let page = 1; page <= maxPages; page += 1) {
      const query: NuvionListQuery = {
        limit: this.options.historyLimit ?? HISTORY_LIMIT,
      };
      if (sender.entityId !== null) query.entity_id = sender.entityId;
      if (sender.accountId !== null) query.account_id = sender.accountId;
      if (cursor !== undefined) query.cursor = cursor;
      const listed = await this.client.listPage<unknown>(
        op,
        '/transfers',
        query,
      );
      let oldest: number | null = null;
      for (const item of listed.items) {
        const read = readBookTransfer(item);
        if (!read.ok) continue;
        const t = read.transfer;
        if (t.createdAt) {
          oldest = Math.min(oldest ?? Infinity, t.createdAt.getTime());
        }
        if (t.uniqueReference === reference) {
          return { state: 'found', transfer: t };
        }
      }
      if (!listed.pagination.hasNext) {
        return { state: 'not_found', complete: true };
      }
      if (
        since !== null &&
        listed.pagination.order === 'desc' &&
        oldest !== null &&
        oldest < since.getTime()
      ) {
        return { state: 'not_found', complete: true };
      }
      cursor = listed.pagination.nextCursor ?? undefined;
      if (cursor === undefined) return { state: 'not_found', complete: false };
    }
    return { state: 'not_found', complete: false };
  }

  // -------------------------------------------------------------------------
  // Finding a send again
  // -------------------------------------------------------------------------

  /**
   * What Nuvion knows of one of our sends: the id the log kept
   * (`GET /transfers/{id}`), else a walk of the sender's transfers for our
   * `unique_reference`. `found` through the id is a `lookup`, through the
   * walk a `history`. Absent only after a complete walk, never while the send
   * may still be in flight, and never as proof that no money moved (that is
   * `decideRetry`'s word: it never advises a resend).
   */
  async reconcileSend(
    reference: string,
    holder: ProviderHolder,
    since?: Date,
  ): Promise<ProviderReconciliation> {
    const row = await this.need().byReference(reference);
    return this.reconcile(row, reference, holder, since ?? null);
  }

  private async reconcile(
    row: BookTransferRow | null,
    reference: string,
    holder: ProviderHolder | null,
    since: Date | null,
  ): Promise<ProviderReconciliation> {
    if (row?.nuvionId) {
      try {
        const t = await this.readOf(row, row.nuvionId);
        const kept = (await this.keep(row, t, false)) ?? row;
        return {
          state: 'found',
          source: 'lookup',
          transaction: bookTransactionOf(t, kept.sentAt),
        };
      } catch (e) {
        if (e instanceof WalletProviderError) {
          return { state: 'unknown', why: 'unreachable' };
        }
        throw e;
      }
    }
    let sender: { accountId: string | null; entityId: string | null };
    try {
      if (row) {
        sender = { accountId: row.fromAccountId, entityId: row.fromEntityId };
      } else if (holder) {
        sender = await this.senderOf(holder);
      } else {
        return { state: 'unknown', why: 'unrecognised' };
      }
    } catch (e) {
      if (e instanceof WalletProviderError) {
        return { state: 'unknown', why: 'unreachable' };
      }
      throw e;
    }
    const from = since ?? row?.sentAt ?? null;
    const walked = await this.walk(
      sender,
      reference,
      from ? new Date(from.getTime() - HISTORY_MARGIN_MS) : null,
    ).catch((e: unknown) => {
      if (e instanceof WalletProviderError) return null;
      throw e;
    });
    if (walked === null) return { state: 'unknown', why: 'unreachable' };
    if (walked.state === 'found') {
      const t = walked.transfer;
      if (row) {
        const problem = bookTransferProblem(row, t, { requireReference: true });
        if (problem) return { state: 'unknown', why: 'unrecognised' };
        await this.keep(row, t, false);
      } else if (t.paymentType !== NUVION_BOOK_TRANSFER) {
        return { state: 'unknown', why: 'unrecognised' };
      }
      return {
        state: 'found',
        source: 'history',
        transaction: bookTransactionOf(t, row?.sentAt ?? this.now()),
      };
    }
    if (!walked.complete)
      return { state: 'unknown', why: 'history_incomplete' };
    if (
      row &&
      this.now().getTime() - row.sentAt.getTime() <
        (this.settings.moneyTimeoutMs ?? 30_000)
    ) {
      // The request may still be on its way to Nuvion.
      return { state: 'unknown', why: 'too_soon' };
    }
    return { state: 'absent' };
  }

  private async senderOf(
    holder: ProviderHolder,
  ): Promise<{ accountId: string | null; entityId: string | null }> {
    if (holder.kind === 'customer') {
      return { accountId: null, entityId: holder.customerId };
    }
    const op = await this.operationalIdentity();
    return { accountId: op.accountId, entityId: null };
  }

  /** The seam's lookup by our reference: from the log, then the sender's transfers. */
  async findTransactionByReference(reference: string): Promise<ProviderLookup> {
    const row = await this.need().byReference(reference);
    // A reference the log never held was not sent by this adapter: nothing
    // can be asked by it (the sender is unknown), which is not "no such
    // transfer".
    if (!row) return { state: 'unknown' };
    const r = await this.reconcile(row, reference, null, row.sentAt);
    if (r.state === 'found') {
      return { state: 'found', transaction: r.transaction };
    }
    return r.state === 'absent' ? { state: 'absent' } : { state: 'unknown' };
  }

  /** The seam's lookup by Nuvion's id: for a transfer the log holds. */
  async findTransactionById(id: string): Promise<ProviderLookup> {
    if (!isNuvionId(id)) return { state: 'unknown' };
    const row = await this.need().byNuvionId(id);
    // The id of a transfer the log does not hold (an inflow, a payout): the
    // entity it belongs to is unknown here, so a read could answer "not
    // found" for a transfer that exists.
    if (!row) return { state: 'unknown' };
    try {
      const t = await this.readOf(row, id);
      const kept = (await this.keep(row, t, false)) ?? row;
      return { state: 'found', transaction: bookTransactionOf(t, kept.sentAt) };
    } catch (e) {
      if (e instanceof WalletProviderError) return { state: 'unknown' };
      throw e;
    }
  }

  /**
   * The rule for a send whose outcome was unknown, under Nuvion's: a
   * transfer Nuvion has finished is `settled` (completed, failed or
   * reversed), anything else is a wait. Never a resend: Nuvion's idempotency
   * would return the original, but silence is not proof that no money moved
   * (MONEY-17 D1), so no Nuvion send is advised again on absence.
   */
  readonly decideRetry: WalletProvider['decideRetry'] = (_kind, r) => {
    if (
      r.state === 'found' &&
      r.transaction.outcome !== null &&
      r.transaction.outcome !== 'pending'
    ) {
      return { action: 'settled', transaction: r.transaction };
    }
    return { action: 'wait', why: r.state === 'unknown' ? r.why : 'pending' };
  };

  /**
   * What Nuvion knows of a movement named by these references: each one that
   * is a reference of ours or an id of ours is read from the log and
   * Nuvion. Nuvion's deliveries reach the ledger through their handlers
   * (src/nuvion/handlers/), so nothing here is matched by amount and time;
   * a movement this area cannot place is `unknown`, never `absent`.
   */
  async confirmMovement(input: {
    references: readonly string[];
    sender: ProviderHolder | null;
    amountKobo: number;
    around: Date;
    limits: { historyPages: number; byIdChecks: number };
  }): Promise<ProviderMovementConfirmation> {
    const store = this.need();
    const refs = [
      ...new Set(input.references.map((r) => r.trim()).filter(Boolean)),
    ].slice(0, Math.max(1, input.limits.byIdChecks));
    for (const ref of refs) {
      const row =
        (await store.byReference(ref)) ??
        (isNuvionId(ref) ? await store.byNuvionId(ref) : null);
      if (!row) continue;
      const r = await this.reconcile(row, row.reference, null, row.sentAt);
      if (r.state === 'found') {
        return {
          state: 'found',
          transaction: r.transaction,
          secondaryReference: null,
        };
      }
      if (r.state === 'unknown') return { state: 'unknown', why: r.why };
    }
    return { state: 'unknown', why: 'no reference of a book transfer of ours' };
  }

  /** Nuvion keeps one reference for a transfer, its id: there is no second. */
  readonly secondaryReferenceOf: WalletProvider['secondaryReferenceOf'] = () =>
    Promise.resolve(null);

  // -------------------------------------------------------------------------
  // Pieces
  // -------------------------------------------------------------------------

  private checkSend(
    op: NuvionOp,
    input: ProviderWalletTransferInput,
    reference: string,
  ): void {
    const bad = (why: string) =>
      this.error('validation', op.name, [`${AREA}: ${why}; nothing was sent`]);
    if (reference.length < 1 || reference.length > NUVION_MAX_REFERENCE) {
      throw bad(`the reference is 1 to ${NUVION_MAX_REFERENCE} characters`);
    }
    if (!/^[\x21-\x7e]+$/.test(reference)) {
      throw bad('the reference holds a space or a character Nuvion may refuse');
    }
    if (
      input.amountKobo < 1n ||
      input.amountKobo > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw bad('the amount is not a positive whole number of kobo');
    }
    if (
      typeof input.fromAccountNumber !== 'string' ||
      typeof input.toAccountNumber !== 'string'
    ) {
      throw bad('an account is not named');
    }
  }

  private need(op?: NuvionOp): NuvionBookStore {
    if (this.store) return this.store;
    throw this.error('not_configured', op?.name ?? 'book transfer', [
      `${AREA}: no record of book transfers is attached to this adapter`,
    ]);
  }

  private error(
    kind: WalletProviderError['kind'],
    operation: string,
    messages: string[],
    reference: string | null = null,
    recordMayExist = false,
  ): NuvionError {
    return new NuvionError({
      kind,
      operation,
      messages,
      reference,
      recordMayExist,
    });
  }

  private now(): Date {
    return this.options.now ? this.options.now() : new Date();
  }

  private sleep(ms: number): Promise<void> {
    return this.options.sleep
      ? this.options.sleep(ms)
      : new Promise((r) => setTimeout(r, ms));
  }
}
