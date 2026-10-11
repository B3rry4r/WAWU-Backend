import type { ProviderTransaction } from '../../../wallet-provider/wallet-provider.interface';
import {
  compareBalance,
  compareMerchantCharge,
  compareMovements,
  type LedgerGroup,
  type LedgerOutRow,
  requiredInAccount,
  sameLedger,
  sumLedger,
} from '../money-check-compare';

/**
 * The nightly check's comparisons (task MONEY-16) with no database and no
 * provider: what is read goes in, the findings come out.
 */

const NOW = new Date('2026-10-12T01:30:00.000Z');
const MIN = 60_000;
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * MIN);
const SETTLE = 30 * MIN;

function ledger(over: Partial<LedgerOutRow> & { id: string }): LedgerOutRow {
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

function provider(
  over: Partial<ProviderTransaction> & { id: string },
): ProviderTransaction {
  return {
    createdAt: ago(600).toISOString(),
    amountKobo: 10_000n,
    status: 'SUCCESS',
    outcome: 'completed',
    ourReference: `ours-${over.id}`,
    providerReference: null,
    secondaryReference: null,
    sessionId: null,
    kind: 'transfer',
    ...over,
  };
}

function compare(
  rows: LedgerOutRow[],
  theirs: ProviderTransaction[],
  over: { historyComplete?: boolean; windowFrom?: Date | null } = {},
) {
  return compareMovements({
    check: 'movements',
    ledger: rows,
    provider: theirs,
    now: NOW,
    settleMs: SETTLE,
    windowFrom: over.windowFrom === undefined ? ago(60 * 24) : over.windowFrom,
    historyComplete: over.historyComplete ?? true,
  });
}

describe('compareMovements', () => {
  it('finds nothing when every debit is on both sides, however the provider names it', () => {
    const r = compare(
      [
        ledger({ id: 'a' }),
        ledger({ id: 'b', refs: ['fintava-b'] }),
        ledger({ id: 'c', refs: ['tagapay-c'] }),
        ledger({ id: 'd', refs: ['uuid-d'] }),
        ledger({ id: 'e', refs: ['session-e'] }),
      ],
      [
        provider({ id: 'a' }),
        provider({
          id: 'pb',
          ourReference: null,
          providerReference: 'fintava-b',
        }),
        provider({
          id: 'pc',
          ourReference: null,
          secondaryReference: 'tagapay-c',
        }),
        provider({ id: 'uuid-d', ourReference: null }),
        provider({ id: 'pe', ourReference: null, sessionId: 'session-e' }),
      ],
    );
    expect(r.findings).toEqual([]);
    expect(r.compared).toBe(5);
    expect(r.matched).toHaveLength(5);
  });

  it('a debit only the provider has, completed, is a mismatch', () => {
    const r = compare(
      [],
      [provider({ id: 'x', ourReference: 'ref-x', amountKobo: 55_000n })],
    );
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({
      check: 'movements',
      severity: 'mismatch',
      kind: 'provider_only',
      ref: 'ref-x',
      amountKobo: '55000',
    });
  });

  it('a pending or failed record only the provider has moved no money: a notice, not a mismatch', () => {
    const r = compare(
      [],
      [
        provider({
          id: 'p1',
          status: 'PENDING',
          outcome: 'pending',
          amountKobo: 10_000n,
        }),
        provider({
          id: 'p2',
          status: 'PENDING',
          outcome: 'pending',
          amountKobo: 5_000n,
        }),
        provider({
          id: 'f1',
          status: 'FAILURE',
          outcome: 'failed',
          amountKobo: 7_000n,
        }),
      ],
    );
    expect(r.findings).toEqual([]);
    expect(r.notices.provider_pending_not_in_ledger).toEqual({
      count: 2,
      amountKobo: '15000',
    });
    expect(r.notices.provider_failed_not_in_ledger).toEqual({
      count: 1,
      amountKobo: '7000',
    });
  });

  it("the provider's own charges to WAWU are a notice with their sum", () => {
    const r = compare(
      [],
      [
        provider({
          id: 'c1',
          kind: 'charge',
          ourReference: null,
          amountKobo: 500n,
        }),
        provider({
          id: 'c2',
          kind: 'charge',
          ourReference: null,
          amountKobo: 500n,
        }),
      ],
    );
    expect(r.findings).toEqual([]);
    expect(r.notices.provider_charges_to_wawu).toEqual({
      count: 2,
      amountKobo: '1000',
    });
  });

  it('a status the adapter does not read, with no ledger row, is for a person to look at', () => {
    const r = compare(
      [],
      [provider({ id: 'u', status: 'WEIRD<script>', outcome: null })],
    );
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({
      severity: 'look',
      kind: 'status_unknown',
    });
    expect(r.findings[0].detail).toContain('WEIRDscript');
    expect(r.findings[0].detail).not.toContain('<');
  });

  it('a ledger send the provider has no record of is a mismatch once the history was read in full', () => {
    const r = compare([ledger({ id: 'lost', amountKobo: 123_400n })], []);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({
      severity: 'mismatch',
      kind: 'ledger_only',
      ref: 'lost',
      amountKobo: '123400',
    });
    const pending = compare([ledger({ id: 'p', status: 'pending' })], []);
    expect(pending.findings[0].kind).toBe('ledger_only');
  });

  it('a failed or reversed ledger send with no provider record is right: no money moved', () => {
    const r = compare(
      [
        ledger({ id: 'f', status: 'failed' }),
        ledger({ id: 'r', status: 'reversed' }),
      ],
      [],
    );
    expect(r.findings).toEqual([]);
  });

  it('cannot call a ledger row missing when the history was not read back to the window', () => {
    const r = compare([ledger({ id: 'lost' })], [], { historyComplete: false });
    expect(r.findings).toEqual([]);
  });

  it('leaves a movement younger than the settle time to tomorrow, on either side', () => {
    const r = compare(
      [ledger({ id: 'new', occurredAt: ago(5), createdAt: ago(5) })],
      [provider({ id: 'newer', createdAt: ago(3).toISOString() })],
    );
    expect(r.findings).toEqual([]);
    expect(r.notices.too_new_to_judge.count).toBe(2);
  });

  it('only judges movements inside the window, but matches rows from before it', () => {
    const old = ago(60 * 48);
    const r = compare(
      [ledger({ id: 'old', occurredAt: old, createdAt: old })],
      [provider({ id: 'old', createdAt: old.toISOString() })],
      { windowFrom: ago(60 * 24) },
    );
    expect(r.findings).toEqual([]);
    expect(r.compared).toBe(0);
    // A provider debit before the window whose ledger row was loaded is not a mismatch.
    const r2 = compare(
      [
        ledger({
          id: 'edge',
          occurredAt: ago(60 * 25),
          createdAt: ago(60 * 25),
        }),
      ],
      [provider({ id: 'edge', createdAt: ago(60 * 25).toISOString() })],
      { windowFrom: ago(60 * 24) },
    );
    expect(r2.findings).toEqual([]);
  });

  it('a different amount is a mismatch with both figures', () => {
    const r = compare(
      [ledger({ id: 'a', amountKobo: 10_000n })],
      [provider({ id: 'a', amountKobo: 10_100n })],
    );
    expect(r.findings).toEqual([
      expect.objectContaining({
        kind: 'amount_differs',
        severity: 'mismatch',
        ref: 'a',
        amountKobo: '10000',
        otherKobo: '10100',
      }),
    ]);
  });

  const WORDS = {
    completed: 'SUCCESS',
    failed: 'FAILURE',
    pending: 'PENDING',
  } as const;
  it.each([
    ['completed', 'failed', ['status_differs']],
    ['completed', 'pending', ['status_differs']],
    ['pending', 'completed', ['status_differs']],
    ['pending', 'failed', ['status_differs']],
    ['failed', 'completed', ['status_differs']],
    ['failed', 'pending', ['status_differs']],
    ['reversed', 'completed', []],
    ['reversed', 'failed', []],
    ['completed', 'completed', []],
    ['pending', 'pending', []],
    ['failed', 'failed', []],
  ] as const)(
    'ledger %s against provider %s once settled: %j',
    (ledgerStatus, theirs, kinds) => {
      const r = compare(
        [ledger({ id: 'a', status: ledgerStatus })],
        [provider({ id: 'a', outcome: theirs, status: WORDS[theirs] })],
      );
      expect(r.findings.map((f) => f.kind)).toEqual([...kinds]);
    },
  );

  it('a pending ledger row young enough for its webhook is not a status mismatch yet', () => {
    const r = compare(
      [
        ledger({
          id: 'a',
          status: 'pending',
          occurredAt: ago(40),
          createdAt: ago(10),
        }),
      ],
      [provider({ id: 'a', createdAt: ago(40).toISOString() })],
    );
    expect(r.findings).toEqual([]);
  });

  it('two provider records for one ledger row is a mismatch: the money may have left twice', () => {
    const r = compare(
      [ledger({ id: 'a', refs: ['ours-a', 'shared'] })],
      [
        provider({ id: 'p1', ourReference: 'ours-a' }),
        provider({ id: 'p2', ourReference: null, providerReference: 'shared' }),
      ],
    );
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({
      kind: 'provider_only',
      severity: 'mismatch',
    });
    expect(r.findings[0].detail).toContain('twice');
  });

  it('the same provider row listed on two pages is one record, not two', () => {
    const p = provider({ id: 'a' });
    const r = compare([ledger({ id: 'a' })], [p, p]);
    expect(r.findings).toEqual([]);
  });

  it('hands back the matched pairs for the merchant charge check', () => {
    const r = compare(
      [ledger({ id: 'fee', wawuFeeKobo: 1_000n })],
      [provider({ id: 'fee' })],
    );
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0].row.wawuFeeKobo).toBe(1_000n);
  });
});

function group(over: Partial<LedgerGroup>): LedgerGroup {
  return {
    direction: 'in',
    status: 'completed',
    uncertain: false,
    totalKobo: 0n,
    rows: 1,
    touchedMs: 1,
    ...over,
  };
}

describe('the balance', () => {
  it('is completed money in less completed money out, and a pending send widens it downward', () => {
    const sums = sumLedger([
      group({ direction: 'in', totalKobo: 100_000n }),
      group({ direction: 'out', totalKobo: 30_000n }),
      group({ direction: 'out', status: 'pending', totalKobo: 5_000n }),
      group({ direction: 'in', status: 'pending', totalKobo: 2_000n }),
      group({ direction: 'out', status: 'failed', totalKobo: 9_000n }),
      group({ direction: 'out', status: 'reversed', totalKobo: 8_000n }),
    ]);
    const bal = (k: bigint) => ({ availableKobo: k, bookedKobo: k });
    expect(compareBalance(sums, bal(70_000n))).toMatchObject({
      match: true,
      baseKobo: 70_000n,
      lowKobo: 65_000n,
      highKobo: 72_000n,
    });
    expect(compareBalance(sums, bal(65_000n)).match).toBe(true);
    expect(compareBalance(sums, bal(72_000n)).match).toBe(true);
    expect(compareBalance(sums, bal(64_999n)).match).toBe(false);
    expect(compareBalance(sums, bal(72_001n)).match).toBe(false);
  });

  it('a failed bank send nobody saw come back may or may not have left', () => {
    const sums = sumLedger([
      group({ direction: 'in', totalKobo: 50_000n }),
      group({
        direction: 'out',
        status: 'failed',
        uncertain: true,
        totalKobo: 6_500n,
      }),
    ]);
    const b = (k: bigint) => ({ availableKobo: k, bookedKobo: k });
    expect(compareBalance(sums, b(50_000n)).match).toBe(true);
    expect(compareBalance(sums, b(43_500n)).match).toBe(true);
    expect(compareBalance(sums, b(43_499n)).match).toBe(false);
  });

  it("either of the provider's two figures inside the range is a match", () => {
    const sums = sumLedger([group({ direction: 'in', totalKobo: 10_000n })]);
    expect(
      compareBalance(sums, { availableKobo: 9_000n, bookedKobo: 10_000n })
        .match,
    ).toBe(true);
    expect(
      compareBalance(sums, { availableKobo: 9_000n, bookedKobo: 9_500n }).match,
    ).toBe(false);
  });

  it('reports the difference as the provider less the ledger', () => {
    const sums = sumLedger([group({ direction: 'in', totalKobo: 10_000n })]);
    expect(
      compareBalance(sums, { availableKobo: 12_500n, bookedKobo: 12_500n })
        .differenceKobo,
    ).toBe(2_500n);
    expect(
      compareBalance(sums, { availableKobo: 4_000n, bookedKobo: 4_000n })
        .differenceKobo,
    ).toBe(-6_000n);
  });

  it('knows two reads of one ledger from a ledger that moved', () => {
    const a = sumLedger([group({ totalKobo: 5n, touchedMs: 10 })]);
    expect(
      sameLedger(a, sumLedger([group({ totalKobo: 5n, touchedMs: 10 })])),
    ).toBe(true);
    expect(
      sameLedger(a, sumLedger([group({ totalKobo: 5n, touchedMs: 11 })])),
    ).toBe(false);
    expect(
      sameLedger(a, sumLedger([group({ totalKobo: 6n, touchedMs: 10 })])),
    ).toBe(false);
    expect(sameLedger(a, sumLedger([]))).toBe(false);
  });
});

describe("WAWU's charge and the held money", () => {
  it("compares the charge on the provider's record with the ledger's fee", () => {
    expect(compareMerchantCharge(1_000n, { merchantChargeKobo: 1_000n })).toBe(
      'ok',
    );
    expect(compareMerchantCharge(1_000n, { merchantChargeKobo: 900n })).toBe(
      'differs',
    );
    expect(compareMerchantCharge(1_000n, { merchantChargeKobo: 0n })).toBe(
      'differs',
    );
    expect(compareMerchantCharge(1_000n, { merchantChargeKobo: null })).toBe(
      'missing',
    );
    expect(compareMerchantCharge(1_000n, {})).toBe('missing');
  });

  it('needs the whole price of an open hold, less a move already handed over', () => {
    expect(requiredInAccount({ heldKobo: 100_000n, handedOverKobo: 0n })).toBe(
      100_000n,
    );
    expect(
      requiredInAccount({ heldKobo: 100_000n, handedOverKobo: 85_000n }),
    ).toBe(15_000n);
    expect(requiredInAccount({ heldKobo: 0n, handedOverKobo: 5n })).toBe(0n);
  });
});
