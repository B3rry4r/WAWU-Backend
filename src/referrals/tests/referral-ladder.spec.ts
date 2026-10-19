import { loadPlansConfig } from '../../plans/plans-config';
import { codeCandidate, nameStem, normalizeCode } from '../referral-code';
import {
  levelsReached,
  multiplierMilliFor,
  nextMilestone,
  rewardPoints,
} from '../referral-ladder';

const plan = loadPlansConfig().referral;

describe('referral ladder (REF-02)', () => {
  it('the multiplier follows the verified count: x1, 1.25, 1.5, 2, 3', () => {
    const at = (n: number) => multiplierMilliFor(plan.levels, n) / 1000;
    expect([0, 1, 2, 3, 5, 6, 10, 11, 25, 26, 400].map(at)).toEqual([
      1, 1, 1, 1.25, 1.25, 1.5, 1.5, 2, 2, 3, 3,
    ]);
    expect(
      [0, 1, 3, 6, 11, 26].map((n) => levelsReached(plan.levels, n)),
    ).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('the multiplier never leaves x1 to x3 on the launch levels', () => {
    for (let n = 0; n < 60; n++) {
      const m = multiplierMilliFor(plan.levels, n);
      expect(m).toBeGreaterThanOrEqual(1000);
      expect(m).toBeLessThanOrEqual(3000);
    }
  });

  it('points are the base times the multiplier, whole, half up', () => {
    expect(rewardPoints(100, 1250)).toBe(125);
    expect(rewardPoints(300, 1500)).toBe(450);
    expect(rewardPoints(500, 3000)).toBe(1500);
    expect(rewardPoints(100, 1000)).toBe(100);
    expect(rewardPoints(3, 1250)).toBe(4);
    expect(rewardPoints(0, 3000)).toBe(0);
  });

  it('the next milestone is the first one above the count, none when all are reached', () => {
    expect(nextMilestone(plan.milestones, 0)).toEqual({
      count: 5,
      points: 500,
    });
    expect(nextMilestone(plan.milestones, 5)).toEqual({
      count: 10,
      points: 1500,
    });
    expect(nextMilestone(plan.milestones, 9)).toEqual({
      count: 10,
      points: 1500,
    });
    expect(nextMilestone(plan.milestones, 10)).toBeNull();
    expect(
      nextMilestone(
        [
          { count: 25, points: 5000 },
          { count: 5, points: 500 },
        ],
        6,
      ),
    ).toEqual({ count: 25, points: 5000 });
  });

  it('the launch milestones are the ones drawn on RF1 only: the 25 step is off', () => {
    expect(plan.milestones.map((m) => m.count)).toEqual([5, 10]);
  });
});

describe('referral codes (REF-02)', () => {
  it('reads a code from a code or a link, in any case', () => {
    expect(normalizeCode('lennox')).toBe('LENNOX');
    expect(normalizeCode(' wawu/r/Lennox ')).toBe('LENNOX');
    expect(normalizeCode('wawu/r/lennox/')).toBeNull();
    expect(normalizeCode('ab')).toBeNull();
    expect(normalizeCode('a b c')).toBeNull();
    expect(normalizeCode('x'.repeat(21))).toBeNull();
    expect(normalizeCode('')).toBeNull();
  });

  it('makes a stem from the first name: letters only, accents dropped', () => {
    expect(nameStem('Lennox')).toBe('LENNOX');
    expect(nameStem('Chiamaka-Ngozi')).toBe('CHIAMAKANG');
    expect(nameStem('Zoë')).toBe('ZOE');
    expect(nameStem('12 !')).toBe('');
    expect(nameStem(null)).toBe('');
  });

  it('tries the name, then the name with digits, then a random code', () => {
    expect(codeCandidate('LENNOX', 0)).toBe('LENNOX');
    for (let a = 1; a < 5; a++)
      expect(codeCandidate('LENNOX', a)).toMatch(
        new RegExp(`^LENNOX\\d{${a + 1}}$`),
      );
    expect(codeCandidate('LENNOX', 6)).toMatch(/^[A-Z2-9]{8}$/);
    expect(codeCandidate('AB', 0)).toMatch(/^[A-Z2-9]{8}$/);
    for (let a = 0; a < 20; a++)
      expect(codeCandidate('CHIAMAKANG', a)).toMatch(/^[A-Z0-9]{3,20}$/);
  });
});
