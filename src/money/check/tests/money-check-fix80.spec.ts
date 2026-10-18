import type { ProviderTransaction } from '../../../wallet-provider/wallet-provider.interface';
import {
  balanceAt,
  compareMovements,
  isExplainedByRow,
  type LedgerOutRow,
  quietCut,
} from '../money-check-compare';
import { chargeDifferenceNote } from '../../ledger/ledger-notes';
import { referenceOfReturn } from '../../../nuvion/fee-legs';

/**
 * FIX-80, with no database and no provider: where a long history is cut, the
 * balance at the cut, and when a line is the money coming back for a move the
 * ledger holds as reversed.
 */

const NOW = new Date('2026-10-12T01:30:00.000Z');
const MIN = 60_000;
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * MIN);
const SETTLE = 30 * MIN;

function row(over: Partial<LedgerOutRow> & { id: string }): LedgerOutRow {
  return {
    status: 'completed',
    amountKobo: 10_000n,
    wawuFeeKobo: null,
    occurredAt: ago(600),
    createdAt: ago(600),
    refs: [`ours-${over.id}`],
    ...over,
  };
}

function line(
  over: Partial<ProviderTransaction> & { id: string },
): ProviderTransaction {
  return {
    createdAt: ago(600).toISOString(),
    amountKobo: 10_000n,
    status: 'completed',
    outcome: 'completed',
    ourReference: `ours-${over.id}`,
    providerReference: null,
    secondaryReference: null,
    sessionId: null,
    kind: 'transfer',
    direction: 'out',
    ...over,
  };
}

/** The out pass, the way the service calls it for a provider that states directions. */
function outPass(
  ledger: LedgerOutRow[],
  provider: ProviderTransaction[],
  related: LedgerOutRow[] = [],
) {
  return compareMovements({
    check: 'movements',
    ledger,
    related,
    provider,
    now: NOW,
    settleMs: SETTLE,
    windowFrom: ago(60 * 24),
    historyComplete: true,
    direction: 'out',
  });
}

/** The in pass. */
function inPass(
  ledger: LedgerOutRow[],
  provider: ProviderTransaction[],
  related: LedgerOutRow[] = [],
) {
  return compareMovements({
    check: 'movements',
    ledger,
    related,
    provider,
    now: NOW,
    settleMs: SETTLE,
    windowFrom: ago(60 * 24),
    historyComplete: true,
    direction: 'in',
  });
}

describe('quietCut', () => {
  const H = 3_600_000;
  it('cuts in the middle of the longest quiet stretch', () => {
    expect(quietCut([1 * H, 2 * H, 8 * H], 0, 10 * H, 60_000)).toBe(5 * H);
  });
  it('counts the stretch up to the end of the range, and from its start', () => {
    expect(quietCut([1 * H], 0, 10 * H, 60_000)).toBe(5.5 * H);
    expect(quietCut([9 * H], 0, 10 * H, 60_000)).toBe(4.5 * H);
  });
  it('takes the later of two equal stretches', () => {
    expect(quietCut([5 * H], 0, 10 * H, 60_000)).toBe(7.5 * H);
  });
  it('ignores moves outside the range', () => {
    expect(quietCut([-5 * H, 20 * H], 0, 10 * H, 60_000)).toBe(5 * H);
  });
  it('gives no cut when no stretch is long enough', () => {
    const dense = Array.from({ length: 100 }, (_, i) => (i + 1) * 100_000);
    expect(quietCut(dense, 0, 101 * 100_000, 120_000)).toBeNull();
  });
});

describe('balanceAt', () => {
  const at = (minutes: number) => ago(minutes).toISOString();
  const mine = (
    id: string,
    minutes: number,
    direction: 'in' | 'out',
    amount: bigint,
    after: bigint | null,
  ) =>
    line({
      id,
      createdAt: at(minutes),
      direction,
      amountKobo: amount,
      feeKobo: 0n,
      balanceAfterKobo: after,
    });

  it('is the balance before the oldest completed line from the cut on', () => {
    const lines = [
      mine('c', 10, 'in', 500n, 1_700n),
      mine('b', 20, 'out', 300n, 1_200n),
      mine('a', 30, 'in', 1_000n, 1_500n),
    ];
    // The cut is 25 minutes ago: line b is the first after it, and the account
    // held 1,200 + 300 before it.
    expect(balanceAt(lines, ago(25).getTime())).toBe(1_500n);
  });
  it('is the balance stated after the newest line before the cut when nothing came after it', () => {
    const lines = [
      mine('b', 20, 'out', 300n, 1_200n),
      mine('a', 30, 'in', 1_000n, 1_500n),
    ];
    expect(balanceAt(lines, ago(5).getTime())).toBe(1_200n);
  });
  it('is not given when the statement does not state it', () => {
    expect(
      balanceAt([mine('a', 30, 'in', 1_000n, null)], ago(5).getTime()),
    ).toBeNull();
    expect(balanceAt([], ago(5).getTime())).toBeNull();
  });
  it('is not given when two lines at the last moment state two figures', () => {
    const lines = [
      mine('b', 20, 'out', 300n, 1_200n),
      mine('a', 20, 'in', 1_000n, 1_500n),
    ];
    expect(balanceAt(lines, ago(5).getTime())).toBeNull();
  });
});

describe('a return of a reversed move', () => {
  const sent = row({
    id: 's',
    status: 'reversed',
    amountKobo: 100_000n,
    totalKobo: 102_500n,
  });
  const original = line({
    id: 's',
    amountKobo: 100_000n,
    feeKobo: 2_500n,
    createdAt: ago(600).toISOString(),
  });
  const back = (over: Partial<ProviderTransaction> = {}) =>
    line({
      id: 'back',
      ourReference: 'ours-s_reversal',
      returnOf: 'ours-s',
      direction: 'in',
      amountKobo: 102_500n,
      createdAt: ago(590).toISOString(),
      ...over,
    });

  it('is read as the money coming back, by the reference it states', () => {
    const r = inPass([], [original, back()], [sent]);
    expect(r.findings).toEqual([]);
    expect(r.notices.reversal_returned).toEqual({
      count: 1,
      amountKobo: '102500',
    });
    const o = outPass([sent], [original, back()], []);
    expect(o.findings).toEqual([]);
  });

  it('is read by the reference the ledger kept of it, when the line states none', () => {
    const kept = row({
      id: 's',
      status: 'reversed',
      amountKobo: 100_000n,
      totalKobo: 102_500n,
      reversalRef: 'credit-1',
    });
    const credit = back({
      id: 'credit-1',
      ourReference: 'something-else',
      returnOf: null,
    });
    expect(inPass([], [original, credit], [kept]).findings).toEqual([]);
    expect(outPass([kept], [original, credit], []).findings).toEqual([]);
  });

  it('does not rescue a reversed row the provider never returned', () => {
    const o = outPass([sent], [original], []);
    expect(o.findings.map((f) => f.kind)).toEqual(['status_differs']);
  });

  it('does not accept a return for less than the amount, or for more than it took', () => {
    for (const amountKobo of [50_000n, 103_000n]) {
      const o = outPass([sent], [original, back({ amountKobo })], []);
      expect(o.findings.map((f) => f.kind)).toEqual(['status_differs']);
      const i = inPass([], [original, back({ amountKobo })], [sent]);
      expect(i.findings.map((f) => f.kind)).toEqual(['provider_only']);
    }
  });

  it('does not accept a line that goes the same way as the move', () => {
    const same = back({ direction: 'out' });
    const o = outPass([sent], [original, same], []);
    expect(o.findings.map((f) => f.kind)).toContain('status_differs');
  });

  it('is a credit nobody wrote when the ledger does not hold the move as reversed', () => {
    const completed = row({
      id: 's',
      amountKobo: 100_000n,
      totalKobo: 102_500n,
    });
    const i = inPass([], [original, back()], [completed]);
    expect(i.findings.map((f) => f.kind)).toEqual(['provider_only']);
    expect(i.notices.reversal_returned).toBeUndefined();
  });

  it('reads the receiver of a reversed WAWU send: its credit, then the debit that took it back', () => {
    const got = row({ id: 'r', status: 'reversed', amountKobo: 100_000n });
    const credit = line({
      id: 'r',
      direction: 'in',
      amountKobo: 100_000n,
      createdAt: ago(600).toISOString(),
    });
    const take = line({
      id: 'r-back',
      ourReference: 'ours-r_reversal',
      returnOf: 'ours-r',
      direction: 'out',
      amountKobo: 100_000n,
      createdAt: ago(590).toISOString(),
    });
    expect(inPass([got], [credit, take], []).findings).toEqual([]);
    const o = outPass([], [credit, take], [got]);
    expect(o.findings).toEqual([]);
    expect(o.notices.reversal_returned).toEqual({
      count: 1,
      amountKobo: '100000',
    });
  });

  it('is read for a send old enough to have left the ledger rows the pass loads', () => {
    const old = row({
      id: 'o',
      status: 'reversed',
      amountKobo: 100_000n,
      totalKobo: 102_500n,
      occurredAt: ago(60 * 24 * 5),
      createdAt: ago(60 * 24 * 5),
    });
    const credit = back({
      returnOf: 'ours-o',
      ourReference: 'ours-o_reversal',
    });
    const i = inPass([], [credit], [old]);
    expect(i.findings).toEqual([]);
    expect(i.notices.reversal_returned?.count).toBe(1);
  });
});

describe('referenceOfReturn', () => {
  it('names the move a return line gives back', () => {
    expect(referenceOfReturn('abc_reversal')).toBe('abc');
    expect(referenceOfReturn('_reversal')).toBeNull();
    expect(referenceOfReturn('abc')).toBeNull();
  });
});

describe('isExplainedByRow', () => {
  it('holds for a row whose note states the charge the row holds', () => {
    expect(
      isExplainedByRow('Nuvion', {
        status: 'completed',
        amountKobo: 80_000n,
        discrepancy: chargeDifferenceNote('Nuvion', 4_000, 2_500),
        providerFeeKobo: 4_000n,
      }),
    ).toBe(true);
  });
  it('does not hold when the row holds another charge, none, or the note says more', () => {
    const good = chargeDifferenceNote('Nuvion', 4_000, 2_500);
    for (const over of [
      { providerFeeKobo: 3_000n },
      { providerFeeKobo: null },
      { discrepancy: `${good}; and something else` },
      { status: 'pending' as const },
    ]) {
      expect(
        isExplainedByRow('Nuvion', {
          status: 'completed',
          amountKobo: 80_000n,
          discrepancy: good,
          providerFeeKobo: 4_000n,
          ...over,
        }),
      ).toBe(false);
    }
  });
});
