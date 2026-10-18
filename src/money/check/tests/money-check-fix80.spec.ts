import type { ProviderTransaction } from '../../../wallet-provider/wallet-provider.interface';
import {
  type AccountRow,
  accountLedgerSums,
  compareAccountBalance,
  compareMovements,
  cutStatement,
  isExplainedByRow,
  type LedgerOutRow,
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

/** A completed line that states the balance right after it, `minutes` ago. */
function stated(
  id: string,
  minutes: number,
  direction: 'in' | 'out',
  amount: bigint,
  after: bigint | null,
  over: Partial<ProviderTransaction> = {},
): ProviderTransaction {
  return line({
    id,
    createdAt: ago(minutes).toISOString(),
    direction,
    amountKobo: amount,
    feeKobo: 0n,
    balanceAfterKobo: after,
    ...over,
  });
}

describe('cutStatement', () => {
  // Newest first, as a statement is read: balances 1,500 -> 1,200 -> 1,700.
  const statement = () => [
    stated('c', 10, 'in', 500n, 1_700n),
    stated('b', 20, 'out', 300n, 1_200n),
    stated('a', 30, 'in', 1_000n, 1_500n),
    stated('z', 40, 'in', 500n, 500n),
  ];

  it('cuts at the newest completed line before the window, and takes the balance it states', () => {
    const cut = cutStatement(statement(), ago(25).getTime());
    expect(cut?.openingKobo).toBe(1_500n);
    expect(cut?.atMs).toBe(ago(30).getTime());
    expect(cut?.after.map((p) => p.id)).toEqual(['c', 'b']);
    expect(cut?.before.map((p) => p.id)).toEqual(['a', 'z']);
  });

  it('has nothing after the cut when the window starts after the newest line', () => {
    const cut = cutStatement(statement(), ago(5).getTime());
    expect(cut?.openingKobo).toBe(1_700n);
    expect(cut?.after).toEqual([]);
  });

  it('cuts before the first line when the whole history was read', () => {
    const cut = cutStatement(statement(), null);
    expect(cut?.openingKobo).toBe(0n);
    expect(cut?.atMs).toBeNull();
    expect(cut?.after).toHaveLength(4);
    expect(cut?.before).toEqual([]);
  });

  it('needs no quiet moment: lines every thirty seconds are cut like any other', () => {
    const lines = Array.from({ length: 400 }, (_, i) =>
      stated(`l${i}`, 0.5 * (i + 1), 'in', 10n, BigInt(4_000 - 10 * i)),
    );
    const cut = cutStatement(lines, ago(100).getTime());
    // Line l200 (100.5 minutes ago) is the newest before the window.
    expect(cut?.after).toHaveLength(200);
    expect(cut?.openingKobo).toBe(BigInt(4_000 - 10 * 200));
  });

  it('does not cut between lines that share one moment', () => {
    const lines = [
      stated('d', 10, 'in', 500n, 2_200n),
      stated('c', 20, 'in', 500n, 1_700n),
      stated('b', 20, 'in', 200n, 1_200n),
      stated('a', 30, 'in', 1_000n, 1_000n),
    ];
    // A cut at line c would leave line b, at the same moment, on the other side.
    // The window starts 15 minutes ago: the lines before it are c, b and a, and
    // the newest, c, shares its moment with the line just older, b: the chain
    // from c to b still follows, so c is a fair cut; but a cut at d is not
    // offered, as d is after the window.
    const cut = cutStatement(lines, ago(15).getTime());
    expect(cut?.openingKobo).toBe(1_700n);
    expect(cut?.after.map((p) => p.id)).toEqual(['d']);
    // Two lines sharing the newest moment before the window: the one listed
    // newer cannot be a cut, as the other is just after it in time.
    const tied = [
      stated('y', 20, 'in', 500n, 1_700n),
      stated('x', 20, 'in', 200n, 1_200n),
      stated('w', 30, 'in', 1_000n, 1_000n),
    ];
    expect(cutStatement(tied, ago(15).getTime())?.openingKobo).toBe(1_700n);
  });

  it('passes over a line whose neighbours do not follow from it, for an older one that fits', () => {
    const lines = [
      stated('c', 10, 'in', 500n, 1_700n),
      // b states a balance that does not lead to c's: out of its place.
      stated('b', 20, 'out', 300n, 900n),
      stated('a', 30, 'in', 1_000n, 1_500n),
      stated('z', 40, 'in', 500n, 500n),
    ];
    // a is the newest before the window but b, just after it, does not follow
    // from it; z, whose neighbour a does follow from it, is the cut.
    const cut = cutStatement(lines, ago(25).getTime());
    expect(cut?.openingKobo).toBe(500n);
    expect(cut?.after.map((p) => p.id)).toEqual(['c', 'b', 'a']);
    // With nothing older that fits, there is no cut.
    expect(cutStatement(lines.slice(0, 3), ago(25).getTime())).toBeNull();
  });

  it('is not given when the statement does not state what it needs', () => {
    expect(cutStatement([], ago(5).getTime())).toBeNull();
    expect(
      cutStatement([stated('a', 30, 'in', 1_000n, null)], ago(5).getTime()),
    ).toBeNull();
    expect(
      cutStatement(
        [stated('a', 30, 'in', 1_000n, 5n, { direction: undefined })],
        null,
      ),
    ).toBeNull();
    expect(
      cutStatement(
        [stated('a', 30, 'in', 1_000n, 5n, { createdAt: '' })],
        ago(5).getTime(),
      ),
    ).toBeNull();
    expect(
      cutStatement(
        [
          stated('a', 30, 'in', 1_000n, 5n, {
            outcome: 'pending',
            status: 'pending',
          }),
        ],
        ago(5).getTime(),
      ),
    ).toBeNull();
  });

  it('puts a pending line on a side but never cuts at it', () => {
    const lines = [
      stated('p', 5, 'out', 100n, 1_700n, {
        outcome: 'pending',
        status: 'pending',
      }),
      stated('c', 10, 'in', 500n, 1_700n),
      stated('a', 30, 'in', 1_000n, 1_200n),
    ];
    const cut = cutStatement(lines, ago(7).getTime());
    expect(cut?.openingKobo).toBe(1_700n);
    expect(cut?.after.map((p) => p.id)).toEqual(['p']);
    expect(cut?.before.map((p) => p.id)).toEqual(['c', 'a']);
  });
});

describe('accountLedgerSums', () => {
  const lines = [
    stated('new', 10, 'in', 500n, 1_700n, { ourReference: 'ref-new' }),
    stated('mid', 20, 'out', 300n, 1_200n, { ourReference: 'ref-mid' }),
    stated('old', 30, 'in', 1_000n, 1_500n, { ourReference: 'ref-old' }),
  ];
  const cut = cutStatement(lines, ago(25).getTime())!;
  const r = (over: Partial<AccountRow> & { refs: string[] }): AccountRow => ({
    direction: 'in',
    status: 'completed',
    uncertain: false,
    totalKobo: 100n,
    reversalRef: null,
    occurredAt: ago(15),
    ...over,
  });

  it('counts a row whose line is after the cut, and leaves one whose line is before it', () => {
    const sums = accountLedgerSums(
      [
        r({ refs: ['ref-new'], totalKobo: 500n }),
        r({ refs: ['ref-mid'], direction: 'out', totalKobo: 300n }),
        r({ refs: ['ref-old'], totalKobo: 1_000n }),
      ],
      cut,
    );
    expect(sums.completedIn).toBe(500n);
    expect(sums.completedOut).toBe(300n);
    // And the account balances: 1,500 at the cut, +500 -300 since.
    expect(
      compareAccountBalance(sums, cut.openingKobo, {
        availableKobo: 1_700n,
        bookedKobo: 1_700n,
      }).match,
    ).toBe(true);
  });

  it('places a row by its reference even when its own date is hours from its line', () => {
    const sums = accountLedgerSums(
      [
        r({ refs: ['ref-new'], totalKobo: 500n, occurredAt: ago(60 * 9) }),
        r({
          refs: ['ref-old'],
          totalKobo: 1_000n,
          occurredAt: ago(1),
        }),
      ],
      cut,
    );
    expect(sums.completedIn).toBe(500n);
  });

  it('counts a row with no line when it is pending, whatever its age, or no older than the cut', () => {
    const sums = accountLedgerSums(
      [
        r({ refs: ['gone'], totalKobo: 40n, occurredAt: ago(15) }),
        r({ refs: ['old-gone'], totalKobo: 90n, occurredAt: ago(60 * 40) }),
        r({
          refs: ['slow'],
          status: 'pending',
          totalKobo: 7n,
          occurredAt: ago(60 * 40),
        }),
      ],
      cut,
    );
    expect(sums.completedIn).toBe(40n);
    expect(sums.pendingIn).toBe(7n);
  });

  it('counts the money coming back after the cut for a debit from before it', () => {
    const back = (after: bigint) =>
      stated('back', 12, 'in', 500n, after, {
        ourReference: 'ref-sent_reversal',
        returnOf: 'ref-sent',
      });
    const sent = r({
      refs: ['ref-sent'],
      status: 'reversed',
      direction: 'out',
      totalKobo: 500n,
    });
    // The debit is before the cut (it is in the opening balance), the return after.
    const early = cutStatement(
      [
        back(1_700n),
        stated('mid', 20, 'out', 300n, 1_200n),
        stated('sent', 28, 'out', 500n, 1_500n, { ourReference: 'ref-sent' }),
        stated('old', 30, 'in', 1_000n, 2_000n),
      ],
      ago(25).getTime(),
    )!;
    expect(early.openingKobo).toBe(1_500n);
    expect(accountLedgerSums([sent], early).completedIn).toBe(500n);
    // The debit and its return both after the cut: nothing to count.
    const both = cutStatement(
      [
        back(1_500n),
        stated('sent', 15, 'out', 500n, 1_000n, { ourReference: 'ref-sent' }),
        stated('old', 30, 'in', 1_000n, 1_500n),
      ],
      ago(25).getTime(),
    )!;
    const none = accountLedgerSums([sent], both);
    expect(none.completedIn + none.completedOut).toBe(0n);
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

// SWEEP-MONEY-4 FIX-80 N1: an entirely empty statement for WAWU's account is
// the one way a provider that states directions and balances falls into the
// balance skip (there is no line to read a direction from). It does not read
// clean: every ledger row of the window is named, on the way out and on the
// way in.
describe('an empty statement', () => {
  it('names every ledger row of the window, so the night is never clean', () => {
    const sent = [
      row({ id: 'a', amountKobo: 100_000n }),
      row({ id: 'b', amountKobo: 250_000n }),
      row({ id: 'c', amountKobo: 75_000n }),
    ];
    const o = outPass(sent, []);
    expect(o.findings.map((f) => f.kind)).toEqual([
      'ledger_only',
      'ledger_only',
      'ledger_only',
    ]);
    const i = inPass(sent, []);
    expect(i.findings.map((f) => f.kind)).toEqual([
      'ledger_only',
      'ledger_only',
      'ledger_only',
    ]);
  });
});
