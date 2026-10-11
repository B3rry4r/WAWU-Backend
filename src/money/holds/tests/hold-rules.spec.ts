import {
  HOLD_SWEEP_BUDGET_MS,
  WALLET_WAITS,
  walletWaitRestMs,
} from '../hold-rules';

const MINUTE = 60_000;

describe('walletWaitRestMs (MONEY-18 round 2, F4)', () => {
  it('is a minute for a hold that has only just begun to wait, and never less', () => {
    expect(walletWaitRestMs(0)).toBe(MINUTE);
    expect(walletWaitRestMs(1)).toBe(MINUTE);
    expect(walletWaitRestMs(30_000)).toBe(MINUTE);
    expect(walletWaitRestMs(MINUTE)).toBe(MINUTE);
  });

  it('doubles with the age of the hold: the looks come at 1, 2, 4, 8 ... minutes of age', () => {
    let age = 0;
    const looks: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      age += walletWaitRestMs(age);
      looks.push(age / MINUTE);
    }
    expect(looks).toEqual([1, 2, 4, 8, 16, 32, 64, 124]);
  });

  it('is an hour at most, however old the hold is', () => {
    expect(walletWaitRestMs(60 * MINUTE)).toBe(60 * MINUTE);
    expect(walletWaitRestMs(61 * MINUTE)).toBe(60 * MINUTE);
    expect(walletWaitRestMs(90 * 24 * 60 * MINUTE)).toBe(60 * MINUTE);
  });

  it('reads a clock that ran backwards, or garbage, as a hold that has just begun', () => {
    expect(walletWaitRestMs(-5 * MINUTE)).toBe(MINUTE);
    expect(walletWaitRestMs(Number.NaN)).toBe(MINUTE);
    expect(walletWaitRestMs(Number.POSITIVE_INFINITY)).toBe(MINUTE);
  });
});

describe('the sweep', () => {
  it('stops reading well inside the minute it runs every', () => {
    expect(HOLD_SWEEP_BUDGET_MS).toBeGreaterThan(0);
    expect(HOLD_SWEEP_BUDGET_MS).toBeLessThan(MINUTE);
  });

  it("knows which waits are for a person's wallet", () => {
    expect([...WALLET_WAITS].sort()).toEqual(['payee_wallet', 'payer_wallet']);
  });
});
