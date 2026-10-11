import type { ProviderTransaction } from '../../wallet-provider/wallet-provider.interface';
import type { TransferStatus } from '../money-view.type';
import type { CheckId, Finding, Notice } from './money-check-types';

/**
 * The comparisons of the nightly check (task MONEY-16), with no database and
 * no provider call in them: they take what was read and say what differs.
 * Every one is a pure function of its arguments, so the same night's data
 * always gives the same findings.
 */

// ---------------------------------------------------------------------------
// Debits: the provider's history against the ledger's `out` rows
// ---------------------------------------------------------------------------

/** One `out` row of the ledger, as the comparison needs it. */
export interface LedgerOutRow {
  id: string;
  status: TransferStatus;
  amountKobo: bigint;
  /** WAWU's own fee on the send, when the ledger recorded one. */
  wawuFeeKobo: bigint | null;
  /** When the money moved by the ledger's reckoning. */
  occurredAt: Date;
  /** When the row was first written. */
  createdAt: Date;
  /** Every reference the row is known by (ours, the provider's, ids). */
  refs: readonly string[];
}

export interface DebitCompareInput {
  check: Extract<CheckId, 'movements' | 'merchant_movements'>;
  /** The wallet's `out` rows, loaded from before the window starts. */
  ledger: readonly LedgerOutRow[];
  /** The provider's debits for the same wallet, read back past the window. */
  provider: readonly ProviderTransaction[];
  now: Date;
  /** Movements younger than this are left to tomorrow's run. */
  settleMs: number;
  /** The start of the window; null: no lower bound. */
  windowFrom: Date | null;
  /**
   * True when the provider's history was read back to the start of the
   * window. Only then can a ledger row with no record at the provider be
   * called missing.
   */
  historyComplete: boolean;
}

export interface DebitCompareResult {
  findings: Finding[];
  notices: Record<string, Notice>;
  /** Provider rows and ledger rows that were judged. */
  compared: number;
  /** The pairs found to be the same movement, inside the window and settled. */
  matched: Array<{ row: LedgerOutRow; provider: ProviderTransaction }>;
}

const WORD = /[^A-Za-z0-9 _-]/g;

/** A provider's word for a status, safe to print: letters, digits and spaces. */
function plainWord(raw: string): string {
  return raw.replace(WORD, '').trim().slice(0, 30);
}

function bump(
  notices: Record<string, Notice>,
  key: string,
  amountKobo?: bigint,
): void {
  const n = (notices[key] ??= { count: 0 });
  n.count += 1;
  if (amountKobo !== undefined) {
    n.amountKobo = (BigInt(n.amountKobo ?? '0') + amountKobo).toString();
  }
}

/** The provider's references to one movement, in the order they are tried. */
function providerRefs(p: ProviderTransaction): string[] {
  return [
    p.ourReference,
    p.providerReference,
    p.secondaryReference,
    p.id,
    p.sessionId,
  ].filter((v): v is string => typeof v === 'string' && v.trim() !== '');
}

/** The reference a finding about a provider row carries. */
function providerRowRef(p: ProviderTransaction): string {
  return p.ourReference ?? p.providerReference ?? p.id;
}

/**
 * Compares a wallet's debits at the provider with the ledger's `out` rows.
 *
 * - A provider debit with no ledger row is a mismatch when it completed
 *   (money left a wallet that WAWU has no record of). A provider record that
 *   is only `pending` or `failed` and is not in the ledger moved no money
 *   (naira-api.md: the orphan PENDING rows of a refused bank send), so it is
 *   a notice. A charge the provider made to WAWU itself (`kind` `charge`) is
 *   a notice with its sum.
 * - A ledger `out` row that completed or is pending, with no provider record
 *   and old enough for one to exist, is a mismatch (the ledger says money
 *   left, the provider says nothing did). A `failed` or `reversed` row is not.
 * - A matched pair differs when the amounts differ, or the statuses cannot
 *   both be true.
 * - Two provider records for one ledger row is a mismatch: the money may
 *   have left twice.
 */
export function compareMovements(input: DebitCompareInput): DebitCompareResult {
  const { check, now, settleMs, windowFrom } = input;
  const findings: Finding[] = [];
  const notices: Record<string, Notice> = {};
  const matched: DebitCompareResult['matched'] = [];
  let compared = 0;

  const byRef = new Map<string, LedgerOutRow>();
  for (const row of input.ledger) {
    for (const ref of row.refs) if (!byRef.has(ref)) byRef.set(ref, row);
  }
  const matchOf = (p: ProviderTransaction): LedgerOutRow | null => {
    for (const ref of providerRefs(p)) {
      const hit = byRef.get(ref);
      if (hit) return hit;
    }
    return null;
  };
  const tooNew = (at: Date): boolean => now.getTime() - at.getTime() < settleMs;
  const inWindow = (at: Date): boolean =>
    windowFrom === null || at.getTime() >= windowFrom.getTime();

  // Pass 1: which ledger rows the provider has a record for, whatever the
  // record's age, so a row cannot be called missing because of the order the
  // rows came in.
  const claimed = new Map<string, string>();
  const duplicate = new Set<string>();
  const matches = new Map<ProviderTransaction, LedgerOutRow | null>();
  for (const p of input.provider) {
    const row = matchOf(p);
    matches.set(p, row);
    if (!row) continue;
    const first = claimed.get(row.id);
    if (first === undefined) claimed.set(row.id, p.id);
    else if (first !== p.id) duplicate.add(p.id);
  }

  // Pass 2: judge the provider's rows inside the window.
  for (const p of input.provider) {
    const created = new Date(p.createdAt);
    if (Number.isNaN(created.getTime())) {
      findings.push({
        check,
        severity: 'look',
        kind: 'status_unknown',
        ref: providerRowRef(p),
        detail: 'The provider gave a record with no readable time.',
        amountKobo: p.amountKobo.toString(),
      });
      continue;
    }
    if (!inWindow(created)) continue;
    if (tooNew(created)) {
      bump(notices, 'too_new_to_judge');
      continue;
    }
    compared += 1;
    const row = matches.get(p) ?? null;
    if (!row) {
      judgeProviderOnly(check, p, findings, notices);
      continue;
    }
    if (duplicate.has(p.id)) {
      findings.push({
        check,
        severity: 'mismatch',
        kind: 'provider_only',
        ref: providerRowRef(p),
        detail:
          'The provider has a second record for a movement the ledger holds once: the money may have left twice.',
        amountKobo: row.amountKobo.toString(),
        otherKobo: p.amountKobo.toString(),
      });
      continue;
    }
    matched.push({ row, provider: p });
    judgePair(check, row, p, now, settleMs, findings);
  }

  // Pass 3: ledger rows the provider has no record of.
  for (const row of input.ledger) {
    if (!inWindow(row.occurredAt)) continue;
    if (claimed.has(row.id)) continue;
    if (row.status === 'failed' || row.status === 'reversed') continue;
    const at =
      row.occurredAt.getTime() > row.createdAt.getTime()
        ? row.occurredAt
        : row.createdAt;
    if (tooNew(at)) {
      bump(notices, 'too_new_to_judge');
      continue;
    }
    if (!input.historyComplete) continue;
    compared += 1;
    findings.push({
      check,
      severity: 'mismatch',
      kind: 'ledger_only',
      ref: row.id,
      detail: `The ledger has this send as ${row.status} and the provider has no record of it.`,
      amountKobo: row.amountKobo.toString(),
    });
  }

  return { findings, notices, compared, matched };
}

function judgeProviderOnly(
  check: DebitCompareInput['check'],
  p: ProviderTransaction,
  findings: Finding[],
  notices: Record<string, Notice>,
): void {
  if (p.kind === 'charge') {
    bump(notices, 'provider_charges_to_wawu', p.amountKobo);
    return;
  }
  if (p.outcome === 'pending') {
    bump(notices, 'provider_pending_not_in_ledger', p.amountKobo);
    return;
  }
  if (p.outcome === 'failed') {
    bump(notices, 'provider_failed_not_in_ledger', p.amountKobo);
    return;
  }
  if (p.outcome === null) {
    findings.push({
      check,
      severity: 'look',
      kind: 'status_unknown',
      ref: providerRowRef(p),
      detail: `The provider's status "${plainWord(p.status)}" is not one we read, and the ledger has no row for it.`,
      amountKobo: p.amountKobo.toString(),
    });
    return;
  }
  findings.push({
    check,
    severity: 'mismatch',
    kind: 'provider_only',
    ref: providerRowRef(p),
    detail:
      'The provider shows this debit completed and the ledger has no row for it.',
    amountKobo: p.amountKobo.toString(),
  });
}

function judgePair(
  check: DebitCompareInput['check'],
  row: LedgerOutRow,
  p: ProviderTransaction,
  now: Date,
  settleMs: number,
  findings: Finding[],
): void {
  const l = row.status;
  const o = p.outcome;
  const bothFailed = o === 'failed' && (l === 'failed' || l === 'reversed');
  if (!bothFailed && p.amountKobo !== row.amountKobo) {
    findings.push({
      check,
      severity: 'mismatch',
      kind: 'amount_differs',
      ref: row.id,
      detail:
        'The ledger and the provider have different amounts for this send.',
      amountKobo: row.amountKobo.toString(),
      otherKobo: p.amountKobo.toString(),
    });
  }
  if (o === null) {
    findings.push({
      check,
      severity: 'look',
      kind: 'status_unknown',
      ref: row.id,
      detail: `The provider's status "${plainWord(p.status)}" is not one we read.`,
      amountKobo: row.amountKobo.toString(),
    });
    return;
  }
  const rowAt =
    row.occurredAt.getTime() > row.createdAt.getTime()
      ? row.occurredAt
      : row.createdAt;
  const settled = now.getTime() - rowAt.getTime() >= settleMs;
  const differs = (why: string): void => {
    findings.push({
      check,
      severity: 'mismatch',
      kind: 'status_differs',
      ref: row.id,
      detail: why,
      amountKobo: row.amountKobo.toString(),
    });
  };
  if (o === 'completed') {
    if (l === 'failed') {
      differs(
        'The provider shows this send completed and the ledger shows it failed.',
      );
    } else if (l === 'pending' && settled) {
      differs(
        'The provider shows this send completed and the ledger still shows it pending.',
      );
    }
    return;
  }
  if (o === 'failed') {
    if (l === 'completed') {
      differs(
        'The provider shows this send failed and the ledger shows it completed.',
      );
    } else if (l === 'pending' && settled) {
      differs(
        'The provider shows this send failed and the ledger still shows it pending.',
      );
    }
    return;
  }
  // The provider still has it pending.
  if (l === 'completed' && settled) {
    differs(
      'The ledger shows this send completed and the provider still has it pending.',
    );
  } else if (l === 'failed' && settled) {
    differs(
      'The ledger shows this send failed and the provider still has it pending.',
    );
  }
}

// ---------------------------------------------------------------------------
// Balances: the provider's figure against what the ledger says it should be
// ---------------------------------------------------------------------------

/** One group of a wallet's ledger rows, as the database summed them. */
export interface LedgerGroup {
  direction: 'in' | 'out';
  status: TransferStatus;
  /**
   * A failed bank send whose debit has not been shown to come back (no
   * reversal seen): the money may have left, so it is not counted either way.
   */
  uncertain: boolean;
  totalKobo: bigint;
  rows: number;
  /** The newest `updatedAt` in the group, in milliseconds. */
  touchedMs: number | null;
}

export interface LedgerSums {
  completedIn: bigint;
  completedOut: bigint;
  pendingIn: bigint;
  pendingOut: bigint;
  uncertainOut: bigint;
  rows: number;
  touchedMs: number | null;
}

export function sumLedger(groups: readonly LedgerGroup[]): LedgerSums {
  const s: LedgerSums = {
    completedIn: 0n,
    completedOut: 0n,
    pendingIn: 0n,
    pendingOut: 0n,
    uncertainOut: 0n,
    rows: 0,
    touchedMs: null,
  };
  for (const g of groups) {
    s.rows += g.rows;
    if (
      g.touchedMs !== null &&
      (s.touchedMs === null || g.touchedMs > s.touchedMs)
    ) {
      s.touchedMs = g.touchedMs;
    }
    if (g.status === 'completed') {
      if (g.direction === 'in') s.completedIn += g.totalKobo;
      else s.completedOut += g.totalKobo;
    } else if (g.status === 'pending') {
      if (g.direction === 'in') s.pendingIn += g.totalKobo;
      else s.pendingOut += g.totalKobo;
    } else if (g.status === 'failed' && g.direction === 'out' && g.uncertain) {
      s.uncertainOut += g.totalKobo;
    }
    // `reversed` is a debit that came back in full: it moves nothing.
    // `failed` moved nothing, unless it is uncertain (above).
  }
  return s;
}

/** True when two reads of a wallet's ledger saw exactly the same rows. */
export function sameLedger(a: LedgerSums, b: LedgerSums): boolean {
  return (
    a.completedIn === b.completedIn &&
    a.completedOut === b.completedOut &&
    a.pendingIn === b.pendingIn &&
    a.pendingOut === b.pendingOut &&
    a.uncertainOut === b.uncertainOut &&
    a.rows === b.rows &&
    a.touchedMs === b.touchedMs
  );
}

export interface BalanceComparison {
  match: boolean;
  /** Completed money in less completed money out. */
  baseKobo: bigint;
  /** The lowest and highest the balance can be, given the unsettled rows. */
  lowKobo: bigint;
  highKobo: bigint;
  /** The provider's available balance less the base (negative: it has less). */
  differenceKobo: bigint;
}

/**
 * The provider's balance against the ledger. The base is completed `in` less
 * completed `out`. A `pending` send may or may not have left, a `pending`
 * receipt may or may not have arrived, and a failed bank send nobody has seen
 * come back may not have, so the balance may sit anywhere in between without
 * a difference. Either of the provider's two figures inside the range is a
 * match.
 */
export function compareBalance(
  sums: LedgerSums,
  balance: { availableKobo: bigint; bookedKobo: bigint },
): BalanceComparison {
  const baseKobo = sums.completedIn - sums.completedOut;
  const lowKobo = baseKobo - sums.pendingOut - sums.uncertainOut;
  const highKobo = baseKobo + sums.pendingIn;
  const within = (v: bigint): boolean => v >= lowKobo && v <= highKobo;
  return {
    match: within(balance.availableKobo) || within(balance.bookedKobo),
    baseKobo,
    lowKobo,
    highKobo,
    differenceKobo: balance.availableKobo - baseKobo,
  };
}

// ---------------------------------------------------------------------------
// WAWU's charge and the held money
// ---------------------------------------------------------------------------

/**
 * Whether the provider's own record of a send shows the charge WAWU set in
 * its dashboard ("Merchant charges", OPS-09) as the amount the ledger says
 * WAWU's fee was. A record that says nothing is not zero: `missing`.
 */
export function compareMerchantCharge(
  expectedKobo: bigint,
  record: Pick<ProviderTransaction, 'merchantChargeKobo'>,
): 'ok' | 'missing' | 'differs' {
  const got = record.merchantChargeKobo;
  if (got === undefined || got === null) return 'missing';
  return got === expectedKobo ? 'ok' : 'differs';
}

/**
 * What the open holds need to be sitting in WAWU's account right now. A
 * `held` hold counts its whole price, less the part whose move out of the
 * account was handed to the provider (that money may already be gone, and
 * the confirmation has not come yet).
 */
export function requiredInAccount(parts: {
  heldKobo: bigint;
  handedOverKobo: bigint;
}): bigint {
  const need = parts.heldKobo - parts.handedOverKobo;
  return need > 0n ? need : 0n;
}
