import type {
  LedgerWebhookReading,
  ProviderDeliveries,
  ProviderHolder,
  ProviderLookup,
  ProviderMovementConfirmation,
  ProviderPage,
  ProviderPageQuery,
  ProviderReconciliation,
  ProviderRetryDecision,
  ProviderSendKind,
  ProviderTransaction,
  WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import { WalletProviderError } from '../../wallet-provider/wallet-provider-error';
import type { NuvionClient, NuvionOp } from '../nuvion-client';
import {
  referenceOfReturn,
  sendReferenceOfFee,
  sendReferenceOfFeeBack,
} from '../fee-legs';
import { NuvionError } from '../nuvion-error';
import { nuvionTransferStatus } from '../nuvion-ledger-delivery';
import { isNuvionId, NUVION_NAIRA, readNuvionAccount } from './accounts';
import { readPayoutTransfer } from './payouts';
import {
  type NuvionStatementLine,
  type NuvionWebhookSubscription,
  readStatementLine,
  readWebhookSubscription,
} from './reconcile-readers';

const AREA = 'reconciliation (NUV-08)';

/** Nuvion's statements are one calendar month; a walk goes back this many at most. */
export const NUVION_STATEMENT_MAX_MONTHS = 36;
/** Pages of one month's statement read before the month is called too long. */
export const NUVION_STATEMENT_MAX_PAGES = 200;
const STATEMENT_PAGE = 100;
/** A walk of one account's statement is reused this long by `listTransactions`. */
const WALK_TTL_MS = 60_000;
/** The account behind a person's entity is reused this long. */
const SCOPE_TTL_MS = 5 * 60_000;

/**
 * Reconciliation with Nuvion (task NUV-08): the account statements
 * (`GET /accounts/{id}/statements`, one calendar month a call, pending lines
 * included), the transfers read back one by one (`GET /transfers/{id}`) and
 * the webhook subscriptions (`GET /entity-webhooks`, read only: the docs give
 * no call that extends one, api-reference__webhooks.md "Update a webhook").
 * Nuvion's docs describe no fee simulation, so none is called. The shapes it
 * reads are in reconcile-readers.ts, from those docs. This file is NUV-08's
 * alone.
 *
 * What it never does: move money, add up our own records into a balance, or
 * treat silence as proof. A month it cannot read in full is an error, not a
 * shorter list. Nuvion's balance is the truth; a difference is for a person
 * to see (the findings table), never papered over here.
 *
 * `deliveries`: the ledger consumer reads Fintava's stored deliveries table
 * only. Nuvion's deliveries reach the ledger through their handlers
 * (src/nuvion/handlers/), so the generic reader names no event.
 */
/** The WalletProvider methods this area answers for the adapter. */
export type NuvionReconcileMethods = Pick<
  WalletProvider,
  | 'deliveries'
  | 'findTransactionByReference'
  | 'findTransactionById'
  | 'listTransactions'
  | 'reconcileSend'
  | 'decideRetry'
  | 'confirmMovement'
  | 'secondaryReferenceOf'
>;

/** One account whose statement is read: a person's, or WAWU's operational one. */
export interface NuvionStatementScope {
  accountId: string;
  /** The entity to ask with; null for WAWU's own (the parent entity). */
  entityId: string | null;
}

/** The statement of one calendar month, every page of it. */
export interface NuvionMonthStatement {
  lines: NuvionStatementLine[];
  /** Lines of the answer that could not be read (counted, never guessed at). */
  unreadable: number;
}

interface Walk {
  at: number;
  lines: ProviderTransaction[];
  /** The next month to read going back; null once the account's first is read. */
  next: { year: number; month: number } | null;
  months: number;
  floor: { year: number; month: number } | null;
}

/**
 * What a line's reference says about WAWU's fee transfers and about a move
 * given back (FIX-80); nothing for any other line.
 */
function feeLegFields(
  reference: string | null,
): Pick<ProviderTransaction, 'feeLegOf' | 'feeReturnOf' | 'returnOf'> {
  if (reference === null) return {};
  const leg = sendReferenceOfFee(reference);
  if (leg !== null) return { feeLegOf: leg };
  const back = sendReferenceOfFeeBack(reference);
  if (back !== null) return { feeReturnOf: back };
  const given = referenceOfReturn(reference);
  return given === null ? {} : { returnOf: given };
}

/** A statement line as the seam's transaction. */
export function statementTransaction(
  line: NuvionStatementLine,
): ProviderTransaction {
  return {
    id: line.transferId,
    createdAt: line.createdAt ? line.createdAt.toISOString() : '',
    amountKobo: BigInt(line.amountKobo),
    status: line.status,
    outcome: line.outcome,
    ourReference: line.reference,
    providerReference: line.reference,
    secondaryReference: null,
    sessionId: null,
    feeKobo: line.feeKobo === null ? null : BigInt(line.feeKobo),
    kind: 'transfer',
    direction: line.direction,
    balanceAfterKobo:
      line.balanceAfterKobo === null ? null : BigInt(line.balanceAfterKobo),
    // The transfer that moves WAWU's fee on a send, or gives it back, is a
    // line of its own; the nightly check matches it to its send by these.
    ...feeLegFields(line.reference),
  };
}

const monthBefore = (m: { year: number; month: number }) =>
  m.month === 1
    ? { year: m.year - 1, month: 12 }
    : { year: m.year, month: m.month - 1 };

const monthOf = (d: Date) => ({
  year: d.getUTCFullYear(),
  month: d.getUTCMonth() + 1,
});

const monthIndex = (m: { year: number; month: number }) =>
  m.year * 12 + m.month;

export class NuvionReconcileArea implements NuvionReconcileMethods {
  private readonly walks = new Map<string, Walk>();
  private readonly scopes = new Map<
    string,
    { at: number; scope: NuvionStatementScope }
  >();

  constructor(
    readonly client: NuvionClient,
    private readonly clock: () => number = Date.now,
  ) {}

  readonly deliveries: ProviderDeliveries = {
    ledgerEvents: [],
    read: (): LedgerWebhookReading => ({
      kind: 'unreadable',
      why: 'Nuvion deliveries are read by their own handlers, not the ledger consumer',
    }),
  };

  // -------------------------------------------------------------------------
  // Statements
  // -------------------------------------------------------------------------

  /**
   * The account a holder's statement is of. WAWU's own is the operational
   * account; a person's is their naira account, found from their entity
   * (`GET /accounts`), since the seam names a person by entity id.
   */
  async scopeOf(holder: ProviderHolder): Promise<NuvionStatementScope> {
    if (holder.kind === 'merchant') {
      return {
        accountId: this.client.settings.operationalAccountId,
        entityId: null,
      };
    }
    const entityId = holder.customerId;
    const op: NuvionOp = { name: 'find account', call: 'read' };
    if (!isNuvionId(entityId)) throw this.invalid(op, 'an entity id');
    const hit = this.scopes.get(entityId);
    if (hit && this.clock() - hit.at < SCOPE_TTL_MS) return hit.scope;
    const page = await this.client.listPage<unknown>(op, '/accounts', {
      entity_id: entityId,
      limit: 100,
    });
    const naira = page.items
      .map((row) => readNuvionAccount(row))
      .filter(
        (a): a is NonNullable<typeof a> =>
          a !== null && !a.deleted && a.currency === NUVION_NAIRA,
      );
    if (naira.length !== 1) {
      throw new NuvionError({
        kind: naira.length === 0 ? 'not_found' : 'bad_response',
        operation: op.name,
        messages: [
          `${AREA}: ${naira.length === 0 ? 'the entity has no naira account' : 'the entity has more than one naira account'}`,
        ],
      });
    }
    const scope = { accountId: naira[0].id, entityId };
    this.scopes.set(entityId, { at: this.clock(), scope });
    return scope;
  }

  /**
   * Every line of one calendar month (`GET /accounts/{id}/statements`,
   * `include_pending`), following the cursor to the end (`cursor` is
   * pagination.md's parameter for any list; the statement's own query
   * parameters name none, and its `pagination` answers with `next_cursor`). A month longer
   * than the page cap, or a page that says more follow without a new
   * cursor, is an error: a shorter list is never returned as the month.
   */
  async statementOfMonth(
    scope: NuvionStatementScope,
    year: number,
    month: number,
  ): Promise<NuvionMonthStatement> {
    const op: NuvionOp = { name: 'read statement', call: 'read' };
    if (
      !isNuvionId(scope.accountId) ||
      (scope.entityId !== null && !isNuvionId(scope.entityId)) ||
      !Number.isInteger(year) ||
      year < 2000 ||
      year > 2200 ||
      !Number.isInteger(month) ||
      month < 1 ||
      month > 12
    ) {
      throw this.invalid(op, 'an account or month');
    }
    const lines: NuvionStatementLine[] = [];
    const seenCursors = new Set<string>();
    let unreadable = 0;
    let cursor: string | undefined;
    for (let pages = 1; ; pages += 1) {
      const page = await this.client.statementPage<unknown>(
        op,
        `/accounts/${encodeURIComponent(scope.accountId)}/statements`,
        {
          ...(scope.entityId === null ? {} : { entity_id: scope.entityId }),
          year,
          month,
          include_pending: true,
          limit: STATEMENT_PAGE,
          cursor,
        },
      );
      for (const row of page.items) {
        const read = readStatementLine(row);
        if (read.ok) lines.push(read.line);
        else unreadable += 1;
      }
      if (!page.pagination.hasNext) return { lines, unreadable };
      const next = page.pagination.nextCursor;
      if (next === null || next === cursor || seenCursors.has(next)) {
        throw this.unreadable(
          op,
          'a page says more follow but gives no new cursor',
        );
      }
      if (pages >= NUVION_STATEMENT_MAX_PAGES) {
        throw this.unreadable(op, 'the month is longer than the pages read');
      }
      seenCursors.add(next);
      cursor = next;
    }
  }

  /**
   * The lines created from `since` to `until` (a day, for the sweep): the
   * months that window touches, a day either side so a month that ends at
   * midnight Lagos time is not missed, filtered by each line's own time. A
   * line without a time is kept: it cannot be shown to be old.
   */
  async statementSince(
    scope: NuvionStatementScope,
    since: Date,
    until: Date,
  ): Promise<NuvionMonthStatement> {
    const from = monthOf(new Date(since.getTime() - 86_400_000));
    const to = monthOf(new Date(until.getTime() + 86_400_000));
    const out: NuvionMonthStatement = { lines: [], unreadable: 0 };
    for (
      let m = from;
      monthIndex(m) <= monthIndex(to);
      m =
        m.month === 12
          ? { year: m.year + 1, month: 1 }
          : { ...m, month: m.month + 1 }
    ) {
      const got = await this.statementOfMonth(scope, m.year, m.month);
      out.unreadable += got.unreadable;
      for (const line of got.lines) {
        if (
          line.createdAt === null ||
          (line.createdAt.getTime() >= since.getTime() &&
            line.createdAt.getTime() <= until.getTime() + 60_000)
        ) {
          out.lines.push(line);
        }
      }
    }
    return out;
  }

  /**
   * A holder's transactions, newest first unless `order` is 'ASC', read from
   * the statement month by month, every page of a month. Page `n` of `take`
   * lines is cut from the walk, which is kept a minute so reading page after
   * page does not read the early months again. `hasNextPage` is true while
   * more lines or earlier months remain. Each carries Nuvion's fee and the
   * balance right after it, as the statement states them.
   */
  async listTransactions(
    holder: ProviderHolder,
    query: ProviderPageQuery,
  ): Promise<ProviderPage<ProviderTransaction>> {
    const scope = await this.scopeOf(holder);
    const desc = (query.order ?? 'DESC') === 'DESC';
    const end = query.page * query.take;
    const walk = await this.walk(scope, desc ? end + 1 : Infinity);
    const ordered = desc ? walk.lines : [...walk.lines].reverse();
    const items = ordered.slice(end - query.take, end);
    return {
      items,
      hasNextPage: ordered.length > end || (desc && walk.next !== null),
    };
  }

  private async walk(scope: NuvionStatementScope, need: number): Promise<Walk> {
    const key = scope.accountId;
    let walk = this.walks.get(key);
    const now = this.clock();
    if (!walk || now - walk.at > WALK_TTL_MS) {
      walk = {
        at: now,
        lines: [],
        next: monthOf(new Date(now)),
        months: 0,
        floor: await this.floorOf(scope),
      };
      this.walks.set(key, walk);
    }
    while (walk.lines.length < need && walk.next !== null) {
      const { year, month } = walk.next;
      const got = await this.statementOfMonth(scope, year, month);
      if (got.unreadable > 0) {
        throw this.unreadable(
          { name: 'read statement', call: 'read' },
          `${got.unreadable} lines of ${year}-${String(month).padStart(2, '0')} could not be read`,
        );
      }
      const sorted = got.lines
        .map(statementTransaction)
        .sort(
          (a, b) =>
            Date.parse(b.createdAt || '0') - Date.parse(a.createdAt || '0') ||
            (a.id < b.id ? 1 : -1),
        );
      walk.lines.push(...sorted);
      walk.months += 1;
      const before = monthBefore(walk.next);
      walk.next =
        walk.months >= NUVION_STATEMENT_MAX_MONTHS ||
        (walk.floor !== null && monthIndex(before) < monthIndex(walk.floor))
          ? null
          : before;
    }
    return walk;
  }

  /** The month the account was created in, when Nuvion says. */
  private async floorOf(
    scope: NuvionStatementScope,
  ): Promise<{ year: number; month: number } | null> {
    const op: NuvionOp = { name: 'get account', call: 'read' };
    try {
      const answer = await this.client.get<unknown>(
        op,
        `/accounts/${encodeURIComponent(scope.accountId)}`,
        scope.entityId === null ? undefined : { entity_id: scope.entityId },
      );
      const d = answer.data as Record<string, unknown> | null;
      const account =
        d && typeof d === 'object' && d.account && typeof d.account === 'object'
          ? (d.account as Record<string, unknown>)
          : d;
      const created = account?.created;
      return typeof created === 'number' && created > 0
        ? monthOf(new Date(created))
        : null;
    } catch (e) {
      if (e instanceof WalletProviderError) return null;
      throw e;
    }
  }

  // -------------------------------------------------------------------------
  // Transfers read back
  // -------------------------------------------------------------------------

  /**
   * `GET /transfers/{id}`: one transfer as Nuvion sent it, to be read by the
   * handlers. `entityId` is the person's entity, or null for WAWU's own.
   */
  async getTransfer(
    entityId: string | null,
    transferId: string,
  ): Promise<unknown> {
    const op: NuvionOp = { name: 'get transfer', call: 'read' };
    if (
      !isNuvionId(transferId) ||
      (entityId !== null && !isNuvionId(entityId))
    ) {
      throw this.invalid(op, 'an id');
    }
    const answer = await this.client.get<unknown>(
      op,
      `/transfers/${encodeURIComponent(transferId)}`,
      entityId === null ? undefined : { entity_id: entityId },
    );
    return answer.data;
  }

  // -------------------------------------------------------------------------
  // The webhook subscription
  // -------------------------------------------------------------------------

  /** `GET /entity-webhooks`: every subscription, every page. */
  async listWebhookSubscriptions(): Promise<NuvionWebhookSubscription[]> {
    const op: NuvionOp = { name: 'list webhooks', call: 'read' };
    const all = await this.client.listAll<unknown>(op, '/entity-webhooks', {
      limit: 100,
    });
    if (!all.complete) {
      throw this.unreadable(
        op,
        'the list of subscriptions is longer than the pages read',
      );
    }
    const out: NuvionWebhookSubscription[] = [];
    for (const row of all.items) {
      const sub = readWebhookSubscription(row);
      if (sub) out.push(sub);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // The seam's lookups that the book and payout areas leave to this one
  // -------------------------------------------------------------------------

  /** A reference alone names no sender, so it cannot be asked: never `absent`. */
  findTransactionByReference(): Promise<ProviderLookup> {
    return Promise.resolve({ state: 'unknown' });
  }

  /**
   * A transfer by Nuvion's id, asked as the parent entity (WAWU's own
   * transfers). A person's transfer needs its entity, so a "not found" is
   * `unknown`, never `absent`.
   */
  async findTransactionById(id: string): Promise<ProviderLookup> {
    if (!isNuvionId(id)) return { state: 'unknown' };
    try {
      return await this.lookup(null, id);
    } catch (e) {
      if (e instanceof WalletProviderError) return { state: 'unknown' };
      throw e;
    }
  }

  private async lookup(
    entityId: string | null,
    id: string,
  ): Promise<ProviderLookup> {
    const raw = await this.getTransfer(entityId, id);
    const read = readPayoutTransfer(raw);
    if (!read.ok || read.transfer.id !== id) return { state: 'unknown' };
    const t = read.transfer;
    return {
      state: 'found',
      transaction: {
        id: t.id,
        createdAt: t.createdAt ? t.createdAt.toISOString() : '',
        amountKobo: BigInt(t.amountKobo),
        status: t.status,
        outcome: nuvionTransferStatus(t.status),
        ourReference: t.uniqueReference,
        providerReference: t.uniqueReference,
        secondaryReference: null,
        sessionId: null,
        feeKobo: t.feeStated ? BigInt(t.feeKobo) : null,
        kind: 'transfer',
        direction:
          t.type === 'inflow' ? 'in' : t.type === 'outflow' ? 'out' : null,
      },
    };
  }

  /** Reached through the adapter's book and payout areas; here nothing is known. */
  reconcileSend(): Promise<ProviderReconciliation> {
    return Promise.resolve({ state: 'unknown', why: 'unrecognised' });
  }

  /**
   * Pure. A transfer Nuvion has finished is `settled`; anything else waits.
   * Never a resend: silence is not proof that no money moved.
   */
  decideRetry(
    _kind: ProviderSendKind,
    reconciliation: ProviderReconciliation,
  ): ProviderRetryDecision {
    if (
      reconciliation.state === 'found' &&
      reconciliation.transaction.outcome !== null &&
      reconciliation.transaction.outcome !== 'pending'
    ) {
      return { action: 'settled', transaction: reconciliation.transaction };
    }
    return {
      action: 'wait',
      why: reconciliation.state === 'unknown' ? reconciliation.why : 'pending',
    };
  }

  /**
   * A movement named by Nuvion transfer ids, read as the sender's entity
   * when the sender is a person and as the parent otherwise. Anything else
   * is `unknown`, never `absent`.
   */
  async confirmMovement(input: {
    references: readonly string[];
    sender: ProviderHolder | null;
    amountKobo: number;
    around: Date;
    limits: { historyPages: number; byIdChecks: number };
  }): Promise<ProviderMovementConfirmation> {
    const entityId =
      input.sender?.kind === 'customer' ? input.sender.customerId : null;
    const ids = [...new Set(input.references.map((r) => r.trim()))]
      .filter(isNuvionId)
      .slice(0, Math.max(1, input.limits.byIdChecks));
    for (const id of ids) {
      try {
        const found = await this.lookup(entityId, id);
        if (found.state === 'found') {
          return {
            state: 'found',
            transaction: found.transaction,
            secondaryReference: null,
          };
        }
      } catch (e) {
        if (!(e instanceof WalletProviderError)) throw e;
        return { state: 'unknown', why: 'unreachable' };
      }
    }
    return {
      state: 'unknown',
      why: 'no Nuvion transfer id among the references',
    };
  }

  /** Nuvion keeps one reference for a transfer, its id: there is no second. */
  secondaryReferenceOf(): Promise<string | null> {
    return Promise.resolve(null);
  }

  // -------------------------------------------------------------------------

  private invalid(op: NuvionOp, what: string): NuvionError {
    return new NuvionError({
      kind: 'validation',
      operation: op.name,
      messages: [`${AREA}: ${what} is not in the form we send`],
    });
  }

  private unreadable(op: NuvionOp, why: string): NuvionError {
    return new NuvionError({
      kind: 'bad_response',
      operation: op.name,
      messages: [`${AREA}: ${why}`],
    });
  }
}
