import { chargeDifferenceNote } from '../../ledger/ledger-notes';
import type { ProviderTransaction } from '../../../wallet-provider/wallet-provider.interface';
import {
  compareAccountBalance,
  compareFeeLeg,
  compareMovements,
  isExplainedCharge,
  type LedgerOutRow,
  type LedgerSums,
  openingBalanceOf,
} from '../money-check-compare';

/**
 * FIX-67 round 2: the nightly check on a provider whose statement states which
 * way each line went, the running balance after it, and moves WAWU's fee as a
 * transfer of its own (Nuvion's). Pure: no database, no provider. Each test
 * plants one difference and names the finding it must make, or builds the lines
 * a clean night holds and expects none.
 */

const NOW = new Date('2026-10-18T12:00:00Z');
const SETTLE = 5 * 60_000;
const OLD = '2026-10-18T08:00:00Z';

let seq = 0;
function line(over: Partial<ProviderTransaction>): ProviderTransaction {
  seq += 1;
  return {
    id: `01LINE${String(seq).padStart(20, '0')}`,
    createdAt: OLD,
    amountKobo: 100_000n,
    status: 'completed',
    outcome: 'completed',
    ourReference: null,
    providerReference: null,
    secondaryReference: null,
    sessionId: null,
    feeKobo: 0n,
    kind: 'transfer',
    direction: 'out',
    ...over,
  };
}

function row(over: Partial<LedgerOutRow> & { id: string }): LedgerOutRow {
  return {
    status: 'completed',
    amountKobo: 100_000n,
    wawuFeeKobo: null,
    occurredAt: new Date(OLD),
    createdAt: new Date(OLD),
    refs: [],
    ...over,
  };
}

const base = {
  check: 'movements' as const,
  now: NOW,
  settleMs: SETTLE,
  windowFrom: null,
  historyComplete: true,
};

describe('a credit line is not a debit (G-FIX-67-1)', () => {
  it('matches a credit to the ledger in row and makes no finding', () => {
    const r = compareMovements({
      ...base,
      direction: 'in',
      ledger: [row({ id: 'in1', refs: ['earn-1'], amountKobo: 382_500n })],
      provider: [
        line({ direction: 'in', ourReference: 'earn-1', amountKobo: 382_500n }),
      ],
    });
    expect(r.findings).toEqual([]);
    expect(r.compared).toBe(1);
    expect(r.matched).toHaveLength(1);
  });

  it('leaves a credit out of the debit pass, where it used to read as a debit with no row', () => {
    const credit = line({ direction: 'in', ourReference: 'refund-1' });
    const r = compareMovements({
      ...base,
      ledger: [],
      provider: [credit],
    });
    expect(r.findings).toEqual([]);
    expect(r.compared).toBe(0);
  });

  it('still reads a line that states no direction as a debit (a provider that lists debits only)', () => {
    const r = compareMovements({
      ...base,
      ledger: [],
      provider: [line({ direction: undefined, ourReference: 'x-1' })],
    });
    expect(r.findings.map((f) => f.kind)).toEqual(['provider_only']);
  });

  it('names a credit nobody wrote', () => {
    const r = compareMovements({
      ...base,
      direction: 'in',
      ledger: [],
      provider: [line({ direction: 'in', ourReference: 'who-1' })],
    });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({
      severity: 'mismatch',
      kind: 'provider_only',
      detail:
        'The provider shows this credit completed and the ledger has no row for it.',
    });
  });

  it('names a ledger in row the provider never credited', () => {
    const r = compareMovements({
      ...base,
      direction: 'in',
      ledger: [row({ id: 'in-lost', refs: ['gone-1'] })],
      provider: [],
    });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({
      kind: 'ledger_only',
      ref: 'in-lost',
      detail:
        'The ledger has this receipt as completed and the provider has no record of it.',
    });
  });

  it('names a credit whose amount differs', () => {
    const r = compareMovements({
      ...base,
      direction: 'in',
      ledger: [row({ id: 'in2', refs: ['pay-1'], amountKobo: 150_000n })],
      provider: [
        line({ direction: 'in', ourReference: 'pay-1', amountKobo: 100_000n }),
      ],
    });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({
      kind: 'amount_differs',
      amountKobo: '150000',
      otherKobo: '100000',
      detail:
        'The ledger and the provider have different amounts for this receipt.',
    });
  });
});

describe('a fee leg belongs to its send (G-FIX-67-2)', () => {
  const send = row({
    id: 'send1',
    refs: ['wawu-send-1'],
    wawuFeeKobo: 1_000n,
  });

  it('matches the debit of the fee transfer to the send, with no finding of its own', () => {
    const leg = line({
      ourReference: 'wawu-send-1-fee',
      feeLegOf: 'wawu-send-1',
      amountKobo: 1_000n,
    });
    const r = compareMovements({
      ...base,
      feeLegs: true,
      ledger: [send],
      provider: [line({ ourReference: 'wawu-send-1', feeKobo: 100n }), leg],
    });
    expect(r.findings).toEqual([]);
    expect(r.compared).toBe(2);
    expect(r.legs.get('wawu-send-1')).toBe(leg);
    // The leg is not a second record of the send.
    expect(r.matched).toHaveLength(1);
  });

  it('matches a bank send the same way (the bank reference plus -fee)', () => {
    const r = compareMovements({
      ...base,
      feeLegs: true,
      ledger: [
        row({ id: 'bank1', refs: ['wawu-bank-9'], wawuFeeKobo: 2_500n }),
      ],
      provider: [
        line({ ourReference: 'wawu-bank-9' }),
        line({
          ourReference: 'wawu-bank-9-fee',
          feeLegOf: 'wawu-bank-9',
          amountKobo: 2_500n,
        }),
      ],
    });
    expect(r.findings).toEqual([]);
  });

  it('is still a debit with no ledger row when the send is not in the ledger', () => {
    const r = compareMovements({
      ...base,
      feeLegs: true,
      ledger: [],
      provider: [
        line({
          ourReference: 'nobody-fee',
          feeLegOf: 'nobody',
          amountKobo: 1_000n,
        }),
      ],
    });
    expect(r.findings.map((f) => f.kind)).toEqual(['provider_only']);
  });

  it('names a fee that left the sender on a send the ledger says carried none', () => {
    const r = compareMovements({
      ...base,
      feeLegs: true,
      ledger: [row({ id: 'free1', refs: ['s-2'], wawuFeeKobo: null })],
      provider: [
        line({ ourReference: 's-2' }),
        line({ ourReference: 's-2-fee', feeLegOf: 's-2', amountKobo: 1_000n }),
      ],
    });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({
      kind: 'provider_only',
      ref: 'free1',
      amountKobo: '1000',
    });
  });

  it('reads a line as a fee leg only for a provider that moves the fee that way', () => {
    const r = compareMovements({
      ...base,
      ledger: [send],
      provider: [
        line({ ourReference: 'wawu-send-1', feeKobo: 100n }),
        line({ ourReference: 'wawu-send-1-fee', feeLegOf: 'wawu-send-1' }),
      ],
    });
    expect(r.findings.map((f) => f.kind)).toEqual(['provider_only']);
  });

  it('counts the fee given back to a sender as the return of the send, not a credit nobody wrote', () => {
    const r = compareMovements({
      ...base,
      direction: 'in',
      feeLegs: true,
      ledger: [],
      related: [row({ id: 'sent', refs: ['wawu-send-3'], status: 'failed' })],
      provider: [
        line({
          direction: 'in',
          ourReference: 'wawu-send-3-fee-back',
          feeReturnOf: 'wawu-send-3',
          amountKobo: 1_000n,
        }),
      ],
    });
    expect(r.findings).toEqual([]);
    expect(r.notices.fee_given_back).toEqual({ count: 1, amountKobo: '1000' });
  });

  it('does not excuse a fee-back credit for a send the ledger does not hold', () => {
    const r = compareMovements({
      ...base,
      direction: 'in',
      feeLegs: true,
      ledger: [],
      related: [],
      provider: [
        line({
          direction: 'in',
          ourReference: 'ghost-fee-back',
          feeReturnOf: 'ghost',
        }),
      ],
    });
    expect(r.findings.map((f) => f.kind)).toEqual(['provider_only']);
  });
});

describe('WAWU fee charged on a send, judged by its own transfer', () => {
  const leg = (amount: bigint, fee: bigint | null, outcome = 'completed') =>
    ({
      amountKobo: amount,
      feeKobo: fee,
      outcome,
    }) as Pick<ProviderTransaction, 'amountKobo' | 'feeKobo' | 'outcome'>;

  it('is ok when the sender paid the fee the ledger records, the provider charge on it included', () => {
    expect(compareFeeLeg(1_010n, leg(1_000n, 10n), true)).toBe('ok');
    expect(compareFeeLeg(1_000n, leg(1_000n, null), true)).toBe('ok');
  });

  it('is missing when no transfer of the fee was found in a history read in full', () => {
    expect(compareFeeLeg(1_000n, null, true)).toBe('missing');
  });

  it('is unknown when the history was not read in full, so the transfer may be unread', () => {
    expect(compareFeeLeg(1_000n, null, false)).toBe('unknown');
  });

  it('is missing when the transfer did not complete', () => {
    expect(compareFeeLeg(1_000n, leg(1_000n, 0n, 'pending'), true)).toBe(
      'missing',
    );
    expect(compareFeeLeg(1_000n, leg(1_000n, 0n, 'failed'), true)).toBe(
      'missing',
    );
  });

  it('differs when the transfer moved another sum', () => {
    expect(compareFeeLeg(1_000n, leg(900n, 0n), true)).toBe('differs');
  });
});

describe("WAWU's account: the provider's balance against the ledger (G-FIX-67-3)", () => {
  const sums = (over: Partial<LedgerSums>): LedgerSums => ({
    completedIn: 0n,
    completedOut: 0n,
    pendingIn: 0n,
    pendingOut: 0n,
    uncertainOut: 0n,
    rows: 0,
    touchedMs: null,
    ...over,
  });

  it('reads the opening figure off the oldest completed line of the provider own statement', () => {
    const lines = [
      line({
        createdAt: '2026-10-01T10:00:00Z',
        direction: 'in',
        amountKobo: 5_000n,
        balanceAfterKobo: 100_005_000n,
      }),
      line({
        createdAt: '2026-10-02T10:00:00Z',
        direction: 'out',
        amountKobo: 1_000n,
        feeKobo: 10n,
        balanceAfterKobo: 100_003_990n,
      }),
    ];
    expect(openingBalanceOf(lines)).toBe(100_000_000n);
  });

  it('subtracts a debit and its charge from the figure after it', () => {
    expect(
      openingBalanceOf([
        line({
          direction: 'out',
          amountKobo: 1_000n,
          feeKobo: 100n,
          balanceAfterKobo: 8_900n,
        }),
      ]),
    ).toBe(10_000n);
  });

  it('has no opening figure when a line states no balance, no direction, or two oldest lines disagree', () => {
    expect(
      openingBalanceOf([line({ direction: 'in', balanceAfterKobo: null })]),
    ).toBeNull();
    expect(
      openingBalanceOf([line({ direction: undefined, balanceAfterKobo: 5n })]),
    ).toBeNull();
    expect(
      openingBalanceOf([
        line({ direction: 'in', amountKobo: 100n, balanceAfterKobo: 1_100n }),
        line({ direction: 'in', amountKobo: 100n, balanceAfterKobo: 1_300n }),
      ]),
    ).toBeNull();
    expect(openingBalanceOf([])).toBeNull();
  });

  it('ignores a pending line when finding the opening', () => {
    expect(
      openingBalanceOf([
        line({
          createdAt: '2026-10-01T10:00:00Z',
          outcome: 'pending',
          direction: 'out',
          balanceAfterKobo: 1n,
        }),
        line({
          createdAt: '2026-10-02T10:00:00Z',
          direction: 'in',
          amountKobo: 50n,
          balanceAfterKobo: 150n,
        }),
      ]),
    ).toBe(100n);
  });

  const account = (available: bigint) => ({
    availableKobo: available,
    bookedKobo: available,
  });

  it('matches when the opening plus the ledger is what the provider holds', () => {
    const c = compareAccountBalance(
      sums({ completedIn: 7_000n, completedOut: 2_000n }),
      100_000n,
      account(105_000n),
    );
    expect(c.match).toBe(true);
  });

  it('names an account short of its ledger', () => {
    const c = compareAccountBalance(
      sums({ completedIn: 7_000n, completedOut: 2_000n }),
      100_000n,
      account(104_000n),
    );
    expect(c.match).toBe(false);
    expect(c.differenceKobo).toBe(-1_000n);
  });

  it('names an account above its ledger (the fee leg nobody booked)', () => {
    const c = compareAccountBalance(
      sums({ completedIn: 7_000n }),
      100_000n,
      account(107_035n),
    );
    expect(c.match).toBe(false);
    expect(c.differenceKobo).toBe(35n);
  });

  it('allows what the unsettled rows allow', () => {
    const c = compareAccountBalance(
      sums({ completedIn: 7_000n, pendingOut: 500n }),
      100_000n,
      account(106_600n),
    );
    expect(c.match).toBe(true);
  });
});

describe('a charge the provider stated that the quote did not (cause 5)', () => {
  const stated = 4_000n;
  const note = chargeDifferenceNote('Nuvion', stated, 2_500n);
  const r = (over: Partial<Parameters<typeof isExplainedCharge>[1]> = {}) => ({
    status: 'completed' as const,
    amountKobo: 100_000n,
    providerFeeKobo: stated,
    discrepancy: note,
    ...over,
  });
  const p = (over: Partial<ProviderTransaction> = {}) =>
    line({ amountKobo: 100_000n, feeKobo: stated, ...over });

  it('is explained when the row holds the provider figures and its note is only that note', () => {
    expect(isExplainedCharge('Nuvion', r(), p())).toBe(true);
  });

  it('is explained when a replay wrote the same note twice', () => {
    expect(
      isExplainedCharge('Nuvion', r({ discrepancy: `${note}; ${note}` }), p()),
    ).toBe(true);
  });

  it('is not explained when the row charge is not the provider charge', () => {
    expect(
      isExplainedCharge('Nuvion', r({ providerFeeKobo: 2_500n }), p()),
    ).toBe(false);
  });

  it('is not explained when the amount differs', () => {
    expect(isExplainedCharge('Nuvion', r({ amountKobo: 90_000n }), p())).toBe(
      false,
    );
  });

  it('is not explained when the note states another charge than the provider record', () => {
    expect(
      isExplainedCharge(
        'Nuvion',
        r({ discrepancy: chargeDifferenceNote('Nuvion', 3_000n, 2_500n) }),
        p(),
      ),
    ).toBe(false);
  });

  it('is not explained when the note says anything more', () => {
    expect(
      isExplainedCharge(
        'Nuvion',
        r({ discrepancy: `${note}; a reversal disagreed with this row` }),
        p(),
      ),
    ).toBe(false);
  });

  it('is not explained for another provider note, a row not completed, or a record that is not', () => {
    expect(isExplainedCharge('Another', r(), p())).toBe(false);
    expect(isExplainedCharge('Nuvion', r({ status: 'pending' }), p())).toBe(
      false,
    );
    expect(isExplainedCharge('Nuvion', r(), p({ outcome: 'pending' }))).toBe(
      false,
    );
    expect(isExplainedCharge('Nuvion', r(), p({ feeKobo: null }))).toBe(false);
    expect(isExplainedCharge('Nuvion', r({ discrepancy: null }), p())).toBe(
      false,
    );
  });

  it('keeps its words in the builder the ledger and the recorder share', () => {
    expect(note).toContain('the quote was 2500 kobo;');
  });
});
