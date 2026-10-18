import type { ProviderTransaction } from '../../wallet-provider/wallet-provider.interface';
import { chargeDifferenceNote } from '../ledger/ledger-notes';
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
  /** What the ledger noted when a sighting disagreed with the row (FIX-67: read to tell an explained charge). */
  discrepancy?: string | null;
  /** The provider's own charge as the row holds it. */
  providerFeeKobo?: bigint | null;
  /** What left the wallet (out: amount and fees) or arrived (in): the most a return can give back. */
  totalKobo?: bigint;
  /** The reference of the provider's record of the money coming back, once the ledger has it (FIX-80). */
  reversalRef?: string | null;
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
  /**
   * Which way the money moved on the lines judged (FIX-67). Default `out`: a
   * line that states no direction is read as a debit, as every record of a
   * provider that lists debits only always was. A line that states `in` is
   * judged only in the `in` pass, against the ledger's `in` rows.
   */
  direction?: 'out' | 'in';
  /**
   * The wallet's ledger rows going the other way. The `in` pass needs the
   * sends: the fee given back to a sender is a credit line whose ledger side
   * is the send's own row.
   */
  related?: readonly LedgerOutRow[];
  /**
   * The provider moves WAWU's fee as a transfer of its own (`wawuFeeLeg`,
   * FIX-52): a debit that is such a transfer is part of the send named in
   * `feeLegOf`, and the ledger holds it inside that send's row.
   */
  feeLegs?: boolean;
}

export interface DebitCompareResult {
  findings: Finding[];
  notices: Record<string, Notice>;
  /** Provider rows and ledger rows that were judged. */
  compared: number;
  /** The pairs found to be the same movement, inside the window and settled. */
  matched: Array<{ row: LedgerOutRow; provider: ProviderTransaction }>;
  /**
   * The provider's fee transfers by the reference of the send each belongs to
   * (a completed one before a pending or failed one), read from every line,
   * whatever its age. Empty unless `feeLegs`.
   */
  legs: Map<string, ProviderTransaction>;
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
 * With `direction: 'in'` the same rules compare its credits with the ledger's
 * `in` rows (FIX-67: a provider that states a direction on each line is
 * judged both ways; a credit is not taken for a debit).
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
 * - A debit that is the transfer moving WAWU's fee on a send (`feeLegs`) is
 *   matched to that send by the reference in `feeLegOf`: the sender's ledger
 *   holds the fee inside the send's row, so it has no row of its own. A leg
 *   whose send the ledger does not hold is a debit with no ledger row, as
 *   any. Whether the leg's figure is the fee the row records is the charge
 *   check's (`compareFeeLeg`), made from `legs`.
 * - A credit that is the fee given back to a sender (`feeReturnOf`) is the
 *   return of a send the ledger holds, so it is a notice, not a difference.
 */
export function compareMovements(input: DebitCompareInput): DebitCompareResult {
  const { check, now, settleMs, windowFrom } = input;
  const direction = input.direction ?? 'out';
  const feeLegs = input.feeLegs === true;
  const findings: Finding[] = [];
  const notices: Record<string, Notice> = {};
  const matched: DebitCompareResult['matched'] = [];
  const legs: DebitCompareResult['legs'] = new Map();
  let compared = 0;

  const lines = input.provider.filter(
    (p) => (p.direction ?? 'out') === direction,
  );
  const isLeg = (p: ProviderTransaction): boolean =>
    feeLegs &&
    direction === 'out' &&
    typeof p.feeLegOf === 'string' &&
    p.feeLegOf !== '';

  const byRef = new Map<string, LedgerOutRow>();
  for (const row of input.ledger) {
    for (const ref of row.refs) if (!byRef.has(ref)) byRef.set(ref, row);
  }
  const relatedByRef = new Map<string, LedgerOutRow>();
  for (const row of input.related ?? []) {
    for (const ref of row.refs)
      if (!relatedByRef.has(ref)) relatedByRef.set(ref, row);
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

  // Returns (FIX-80): a completed line that gives back a move the ledger holds
  // as `reversed`, found by the reference the line states it gives back, or by
  // the reference the ledger kept of the money coming back. A line of the
  // other direction than the row, for no less than the row's amount and no
  // more than it took. A reversed row the provider shows no return for is
  // still a difference (the judged pair says so); so is a return of a row the
  // ledger does not call reversed (the line has no row).
  const reversedByRef = new Map<string, LedgerOutRow>();
  for (const row of [...input.ledger, ...(input.related ?? [])]) {
    if (row.status !== 'reversed') continue;
    for (const ref of row.refs)
      if (!reversedByRef.has(ref)) reversedByRef.set(ref, row);
  }
  const reversedByReturn = new Map<string, LedgerOutRow>();
  for (const row of reversedByRef.values()) {
    if (row.reversalRef) reversedByReturn.set(row.reversalRef, row);
  }
  const ledgerIds = new Set(input.ledger.map((r) => r.id));
  const returnedRowOf = (p: ProviderTransaction): LedgerOutRow | null => {
    if (p.outcome !== 'completed') return null;
    let row: LedgerOutRow | null = null;
    if (typeof p.returnOf === 'string' && p.returnOf !== '') {
      row = reversedByRef.get(p.returnOf) ?? null;
    }
    if (row === null) {
      for (const ref of providerRefs(p)) {
        const hit = reversedByReturn.get(ref);
        if (hit) {
          row = hit;
          break;
        }
      }
    }
    if (row === null) return null;
    // Opposite ways: a row of this pass's direction is given back by a line
    // of the other, and the other way round.
    const rowIsThisPass = ledgerIds.has(row.id);
    const lineDirection = p.direction ?? 'out';
    if (rowIsThisPass === (lineDirection === direction)) return null;
    const most = row.totalKobo ?? row.amountKobo;
    if (p.amountKobo < row.amountKobo || p.amountKobo > most) return null;
    return row;
  };
  const returnedRows = new Set<string>();
  for (const p of input.provider) {
    const row = returnedRowOf(p);
    if (row) returnedRows.add(row.id);
  }

  // Pass 1: which ledger rows the provider has a record for, whatever the
  // record's age, so a row cannot be called missing because of the order the
  // rows came in.
  const claimed = new Map<string, string>();
  const duplicate = new Set<string>();
  const matches = new Map<ProviderTransaction, LedgerOutRow | null>();
  for (const p of lines) {
    if (isLeg(p)) {
      const had = legs.get(p.feeLegOf as string);
      if (!had || (had.outcome !== 'completed' && p.outcome === 'completed')) {
        legs.set(p.feeLegOf as string, p);
      }
      continue;
    }
    const row = matchOf(p);
    matches.set(p, row);
    if (!row) continue;
    const first = claimed.get(row.id);
    if (first === undefined) claimed.set(row.id, p.id);
    else if (first !== p.id) duplicate.add(p.id);
  }

  // Pass 2: judge the provider's rows inside the window.
  for (const p of lines) {
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
    const gaveBack = returnedRowOf(p);
    if (gaveBack !== null && !ledgerIds.has(gaveBack.id)) {
      bump(notices, 'reversal_returned', p.amountKobo);
      continue;
    }
    if (isLeg(p)) {
      const send = byRef.get(p.feeLegOf as string) ?? null;
      if (send === null) {
        judgeProviderOnly(check, p, findings, notices, direction);
      } else {
        judgeLegOfSend(check, send, p, now, settleMs, findings);
      }
      continue;
    }
    const row = matches.get(p) ?? null;
    if (!row) {
      if (
        direction === 'in' &&
        feeLegs &&
        typeof p.feeReturnOf === 'string' &&
        relatedByRef.has(p.feeReturnOf)
      ) {
        if (p.outcome === 'completed')
          bump(notices, 'fee_given_back', p.amountKobo);
        continue;
      }
      judgeProviderOnly(check, p, findings, notices, direction);
      continue;
    }
    if (duplicate.has(p.id)) {
      findings.push({
        check,
        severity: 'mismatch',
        kind: 'provider_only',
        ref: providerRowRef(p),
        detail:
          direction === 'in'
            ? 'The provider has a second record for a receipt the ledger holds once: the money may have arrived twice.'
            : 'The provider has a second record for a movement the ledger holds once: the money may have left twice.',
        amountKobo: row.amountKobo.toString(),
        otherKobo: p.amountKobo.toString(),
      });
      continue;
    }
    matched.push({ row, provider: p });
    judgePair(
      check,
      row,
      p,
      now,
      settleMs,
      findings,
      direction,
      returnedRows.has(row.id),
    );
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
      detail: `The ledger has this ${direction === 'in' ? 'receipt' : 'send'} as ${row.status} and the provider has no record of it.`,
      amountKobo: row.amountKobo.toString(),
    });
  }

  return { findings, notices, compared, matched, legs };
}

/**
 * A fee transfer whose send the ledger holds. Its figure against the fee the
 * row records is the charge check's; here only the other way round is a
 * difference: a fee that left the sender's wallet on a send the ledger says
 * carried none. A send that did not stand (failed, reversed) gave the fee
 * back, which the fee-back credit shows.
 */
function judgeLegOfSend(
  check: DebitCompareInput['check'],
  send: LedgerOutRow,
  p: ProviderTransaction,
  now: Date,
  settleMs: number,
  findings: Finding[],
): void {
  if (p.outcome !== 'completed' || send.status !== 'completed') return;
  const rowAt =
    send.occurredAt.getTime() > send.createdAt.getTime()
      ? send.occurredAt
      : send.createdAt;
  if (now.getTime() - rowAt.getTime() < settleMs) return;
  if (send.wawuFeeKobo !== null && send.wawuFeeKobo > 0n) return;
  findings.push({
    check,
    severity: 'mismatch',
    kind: 'provider_only',
    ref: send.id,
    detail:
      'The provider shows a fee transfer for this send and the ledger records no fee on it.',
    amountKobo: p.amountKobo.toString(),
  });
}

function judgeProviderOnly(
  check: DebitCompareInput['check'],
  p: ProviderTransaction,
  findings: Finding[],
  notices: Record<string, Notice>,
  direction: 'out' | 'in' = 'out',
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
      direction === 'in'
        ? 'The provider shows this credit completed and the ledger has no row for it.'
        : 'The provider shows this debit completed and the ledger has no row for it.',
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
  direction: 'out' | 'in' = 'out',
  returned = false,
): void {
  const noun = direction === 'in' ? 'receipt' : 'send';
  const l = row.status;
  const o = p.outcome;
  const bothFailed = o === 'failed' && (l === 'failed' || l === 'reversed');
  if (!bothFailed && p.amountKobo !== row.amountKobo) {
    findings.push({
      check,
      severity: 'mismatch',
      kind: 'amount_differs',
      ref: row.id,
      detail: `The ledger and the provider have different amounts for this ${noun}.`,
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
    // A send the ledger calls failed or reversed (the money came back) while
    // the provider lists it completed: the money did not come back.
    if (l === 'reversed' && returned) {
      // The provider shows the move and the money coming back (FIX-80).
      return;
    }
    if (l === 'failed' || l === 'reversed') {
      differs(
        `The provider shows this ${noun} completed and the ledger shows it ${l}.`,
      );
    } else if (l === 'pending' && settled) {
      differs(
        `The provider shows this ${noun} completed and the ledger still shows it pending.`,
      );
    }
    return;
  }
  if (o === 'failed') {
    if (l === 'completed') {
      differs(
        `The provider shows this ${noun} failed and the ledger shows it completed.`,
      );
    } else if (l === 'pending' && settled) {
      differs(
        `The provider shows this ${noun} failed and the ledger still shows it pending.`,
      );
    }
    return;
  }
  // The provider still has it pending.
  if (l === 'completed' && settled) {
    differs(
      `The ledger shows this ${noun} completed and the provider still has it pending.`,
    );
  } else if ((l === 'failed' || l === 'reversed') && settled) {
    differs(
      `The ledger shows this ${noun} ${l} and the provider still has it pending.`,
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
  /**
   * The provider's booked figure is not its available one (it holds or has
   * pending something). Only a notice: it never decides a match.
   */
  bookedDiffers: boolean;
}

/**
 * The provider's balance against the ledger. The base is completed `in` less
 * completed `out`. A `pending` send may or may not have left, a `pending`
 * receipt may or may not have arrived, and a failed bank send nobody has seen
 * come back may not have, so the balance may sit anywhere in between without
 * a difference.
 *
 * The figure compared is the AVAILABLE balance alone: it is the one the app
 * shows (docs/fintava/naira-api.md). The booked figure never rescues a
 * wallet whose available figure is outside the range (round 2, VF-1): a
 * pending item nobody recorded is exactly the difference this check exists to
 * find, and the booked figure would hide it. A booked figure that differs from
 * the available one is reported as a notice (`bookedDiffers`).
 */
export function compareBalance(
  sums: LedgerSums,
  balance: { availableKobo: bigint; bookedKobo: bigint },
): BalanceComparison {
  const baseKobo = sums.completedIn - sums.completedOut;
  const lowKobo = baseKobo - sums.pendingOut - sums.uncertainOut;
  const highKobo = baseKobo + sums.pendingIn;
  return {
    match:
      balance.availableKobo >= lowKobo && balance.availableKobo <= highKobo,
    baseKobo,
    lowKobo,
    highKobo,
    differenceKobo: balance.availableKobo - baseKobo,
    bookedDiffers: balance.bookedKobo !== balance.availableKobo,
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

/**
 * Whether the transfer that moved WAWU's fee, on a provider that moves it as
 * a transfer of its own (`wawuFeeLeg`, FIX-52), shows the fee the ledger says
 * was charged: what left the sender for it (the amount and the provider's
 * charge on it) is the fee the send's row records (FIX-67). A send with no
 * such transfer, or one that did not complete, is `missing`; `unknown` when
 * the history was not read in full, so the transfer may simply be unread.
 */
export function compareFeeLeg(
  expectedKobo: bigint,
  leg: Pick<ProviderTransaction, 'amountKobo' | 'feeKobo' | 'outcome'> | null,
  historyComplete: boolean,
): 'ok' | 'missing' | 'differs' | 'unknown' {
  if (leg === null) return historyComplete ? 'missing' : 'unknown';
  if (leg.outcome !== 'completed') return 'missing';
  const took = leg.amountKobo + (leg.feeKobo ?? 0n);
  return took === expectedKobo ? 'ok' : 'differs';
}

// ---------------------------------------------------------------------------
// WAWU's own account: the provider's balance against the ledger (FIX-67)
// ---------------------------------------------------------------------------

/** What a completed line did to the balance of the account it is on, in kobo. */
function effectOf(p: ProviderTransaction): bigint | null {
  if (p.direction === 'in') return p.amountKobo;
  if (p.direction === 'out') return -(p.amountKobo + (p.feeKobo ?? 0n));
  return null;
}

/**
 * What the account held before its first line, from the provider's own
 * statement: the running balance it states right after its oldest completed
 * line, less what that line did. Never added up from our records. Null when
 * the statement does not give it (a line states no direction or no balance,
 * or the oldest completed lines share one time and would give two figures):
 * the account's balance is then not compared.
 */
export function openingBalanceOf(
  lines: readonly ProviderTransaction[],
): bigint | null {
  let oldest = Number.POSITIVE_INFINITY;
  const first: ProviderTransaction[] = [];
  for (const p of lines) {
    if (p.outcome !== 'completed') continue;
    const at = Date.parse(p.createdAt);
    if (!Number.isFinite(at)) return null;
    if (at < oldest) {
      oldest = at;
      first.length = 0;
    }
    if (at === oldest) first.push(p);
  }
  if (first.length === 0) return null;
  const openings = new Set<bigint>();
  for (const p of first) {
    const effect = effectOf(p);
    if (effect === null || p.balanceAfterKobo == null) return null;
    openings.add(p.balanceAfterKobo - effect);
  }
  return openings.size === 1 ? [...openings][0] : null;
}

/**
 * The balance WAWU's account held at `cutMs`, from the provider's own
 * statement (FIX-80): what it held before the oldest completed line from that
 * moment on, or, when nothing completed since, what it stated right after the
 * newest completed line before it. Null when the statement does not give it
 * (no completed line at all, a line with no time, no direction or no balance,
 * or lines sharing one time that would give two figures).
 */
export function balanceAt(
  lines: readonly ProviderTransaction[],
  cutMs: number,
): bigint | null {
  const done = lines.filter((p) => p.outcome === 'completed');
  const after = done.filter((p) => Date.parse(p.createdAt) >= cutMs);
  if (after.length > 0) return openingBalanceOf(after);
  let newest = Number.NEGATIVE_INFINITY;
  const last: ProviderTransaction[] = [];
  for (const p of done) {
    const at = Date.parse(p.createdAt);
    if (!Number.isFinite(at)) return null;
    if (at > newest) {
      newest = at;
      last.length = 0;
    }
    if (at === newest) last.push(p);
  }
  if (last.length === 0) return null;
  const figures = new Set<bigint>();
  for (const p of last) {
    if (p.balanceAfterKobo == null) return null;
    figures.add(p.balanceAfterKobo);
  }
  return figures.size === 1 ? [...figures][0] : null;
}

/**
 * Where to cut a long history in two (FIX-80): the middle of the longest
 * stretch between `lo` and `hi` in which nothing happened, if that stretch is
 * at least `minGapMs`. Money before the cut is left to the opening balance and
 * money after it is compared line by line, and the ledger's time for a move
 * and the provider's can differ by a little, so a cut is only safe where no
 * move on either side is near it. Null when there is no such stretch: the
 * account's balance is then not compared this night.
 */
export function quietCut(
  events: readonly number[],
  lo: number,
  hi: number,
  minGapMs: number,
): number | null {
  const points = [
    lo,
    ...events.filter((t) => Number.isFinite(t) && t > lo && t < hi),
    hi,
  ].sort((a, b) => a - b);
  let widest = -1;
  let at: number | null = null;
  for (let i = 1; i < points.length; i += 1) {
    const gap = points[i] - points[i - 1];
    if (gap >= widest) {
      widest = gap;
      at = points[i - 1] + Math.floor(gap / 2);
    }
  }
  return widest >= minGapMs ? at : null;
}

/**
 * Whether the only thing a completed row's ledger note says is that the
 * provider charged other than the quote, judged from the row alone (FIX-80):
 * for a row whose provider line has left the window, so the line can no longer
 * be read beside it. The row holds the provider's own record (its charge is
 * stated on it) and the note states exactly that charge.
 */
export function isExplainedByRow(
  label: string,
  row: Pick<
    LedgerOutRow,
    'status' | 'amountKobo' | 'discrepancy' | 'providerFeeKobo'
  >,
): boolean {
  if (row.providerFeeKobo === null || row.providerFeeKobo === undefined) {
    return false;
  }
  return isExplainedCharge(label, row, {
    amountKobo: row.amountKobo,
    feeKobo: row.providerFeeKobo,
    outcome: 'completed',
  });
}

/**
 * WAWU's own account at the provider against its ledger: what the provider
 * says the account held when its statement began, plus the merchant ledger's
 * completed money in less out, may be anywhere the unsettled rows allow. The
 * same rule as a wallet's (`compareBalance`), from an opening figure instead
 * of from nothing.
 */
export function compareAccountBalance(
  sums: LedgerSums,
  openingKobo: bigint,
  balance: { availableKobo: bigint; bookedKobo: bigint },
): BalanceComparison {
  return compareBalance(sums, {
    availableKobo: balance.availableKobo - openingKobo,
    bookedKobo: balance.bookedKobo - openingKobo,
  });
}

// ---------------------------------------------------------------------------
// A charge the provider stated that the quote did not (FIX-67)
// ---------------------------------------------------------------------------

/**
 * Whether the only thing a completed row's ledger note says is that the
 * provider charged other than the quote, and the row now holds the provider's
 * own record: the same amount, the same charge, completed on both sides. The
 * note is the one `chargeDifferenceNote` writes (the same builder, so the two
 * cannot drift); each copy of it must state the charge the provider's record
 * states, and nothing else may be in the note. A row whose figures differ
 * from the provider's, or whose note says anything more, is not explained: it
 * stays a difference.
 */
export function isExplainedCharge(
  label: string,
  row: Pick<
    LedgerOutRow,
    'status' | 'amountKobo' | 'discrepancy' | 'providerFeeKobo'
  >,
  p: Pick<ProviderTransaction, 'amountKobo' | 'feeKobo' | 'outcome'>,
): boolean {
  const note = row.discrepancy;
  if (!note || row.status !== 'completed' || p.outcome !== 'completed') {
    return false;
  }
  const stated = p.feeKobo;
  if (
    stated === null ||
    stated === undefined ||
    row.providerFeeKobo !== stated ||
    row.amountKobo !== p.amountKobo
  ) {
    return false;
  }
  const quotes = [
    ...new Set(
      [...note.matchAll(/the quote was (\d+) kobo;/g)].map((m) => m[1]),
    ),
  ];
  if (quotes.length === 0) return false;
  let rest = note;
  for (const q of quotes) {
    rest = rest.split(chargeDifferenceNote(label, stated, BigInt(q))).join('');
  }
  return rest.replace(/[;\s]+/g, '') === '';
}
