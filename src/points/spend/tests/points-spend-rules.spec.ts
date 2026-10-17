import { loadPlansConfig, PLAN_ACTIONS } from '../../../plans/plans-config';
import { PointsError } from '../../points-error';
import {
  shortfallGoodsFromTerms,
  shortfallGoodsToTerms,
  shortfallPointsOf,
  shortfallTargetOf,
} from '../points-shortfall-goods';
import {
  ACTION_TITLES,
  capError,
  capStop,
  priceJob,
  shortfallPriceMinor,
} from '../points-spend-rules';
import { LONG_DASH } from '../../../plan-settings/plan-setting-registry';

/**
 * POINTS-03's rules, pure. Every figure is read from the plan the Hub reads
 * (the file here), so a cost or a cap changed in the settings changes these
 * answers and not the code.
 */
const config = loadPlansConfig();
const action = (id: string) => config.actions.find((a) => a.id === id)!;
const minuteAction = config.actions.find((a) => a.per === 'minute')!;
const langAction = config.actions.find((a) => a.per === 'minute_per_language')!;
const useAction = config.actions.find((a) => a.per === 'use')!;
const resetsAt = new Date('2026-10-18T23:00:00.000Z');

describe('priceJob (POINTS-03)', () => {
  it('prices a per-minute job as the plan counts it', () => {
    const job = priceJob(config, { action: minuteAction.id, units: 2 });
    expect(job).toMatchObject({
      action: minuteAction.id,
      per: 'minute',
      perUnitPoints: minuteAction.points,
      units: 2,
      languages: 1,
      costPoints: minuteAction.points * 2,
    });
  });

  it('multiplies dubbing by its languages and refuses languages anywhere else', () => {
    expect(
      priceJob(config, { action: langAction.id, units: 3, languages: 2 })
        .costPoints,
    ).toBe(langAction.points * 6);
    expect(() =>
      priceJob(config, { action: minuteAction.id, units: 1, languages: 2 }),
    ).toThrow(PointsError);
  });

  it('refuses a tool the plan does not price and a count that is not whole', () => {
    for (const bad of [
      { action: 'nope', units: 1 },
      { action: useAction.id, units: 0 },
      { action: useAction.id, units: 1.5 },
      { action: useAction.id, units: -1 },
    ])
      expect(() => priceJob(config, bad)).toThrow(PointsError);
  });

  it('refuses a job whose cost is more than a lot can hold', () => {
    expect(() =>
      priceJob(config, { action: minuteAction.id, units: 2 ** 31 - 1 }),
    ).toThrow(/more points than one job/);
  });

  it('names every priced action in the words a held job is shown under, with no long dash or outside brand', () => {
    for (const id of PLAN_ACTIONS) {
      expect(ACTION_TITLES[id].length).toBeGreaterThan(0);
      expect(ACTION_TITLES[id].length).toBeLessThanOrEqual(60);
      expect(ACTION_TITLES[id]).not.toMatch(LONG_DASH);
      expect(ACTION_TITLES[id].toLowerCase()).not.toContain('eleven');
    }
    expect(
      priceJob(config, { action: 'voiceover_per_min', units: 1 }).title,
    ).toBe(ACTION_TITLES.voiceover_per_min);
    expect(action('voiceover_per_min')).toBeDefined();
  });
});

describe('capStop (POINTS-03, PT7)', () => {
  const caps = config.caps;
  const job = priceJob(config, { action: minuteAction.id, units: 1 });

  it('lets a job through when nothing is over', () => {
    expect(capStop(caps, job, 0, resetsAt)).toBeNull();
    expect(
      capStop(caps, job, caps.dailyPointsPerUser - job.costPoints, resetsAt),
    ).toBeNull();
  });

  it('stops the job that would pass the day, naming the cap, what is left and when it resets', () => {
    const used = caps.dailyPointsPerUser - job.costPoints + 1;
    const stop = capStop(caps, job, used, resetsAt)!;
    expect(stop).toMatchObject({
      cap: 'daily',
      limit: caps.dailyPointsPerUser,
      unit: 'points',
      usedPoints: used,
      remainingPoints: job.costPoints - 1,
      resetsAt: resetsAt.toISOString(),
    });
    expect(stop.message).not.toMatch(LONG_DASH);
    expect(capError(stop)).toMatchObject({
      code: 'points_cap_reached',
      detail: {
        cap: 'daily',
        capLimit: caps.dailyPointsPerUser,
        capUnit: 'points',
        remainingPoints: job.costPoints - 1,
      },
    });
  });

  it('says so when one job alone is more than a day allows', () => {
    const big = {
      ...job,
      per: 'use' as const,
      units: caps.dailyPointsPerUser,
      costPoints: caps.dailyPointsPerUser + 1,
    };
    expect(capStop(caps, big, 0, resetsAt)!.message).toMatch(/daily limit/);
  });

  it('stops a job over the characters or minutes a job can take, which never reset', () => {
    const chars = capStop(
      caps,
      { ...job, characters: caps.maxCharsPerJob + 1 },
      0,
      resetsAt,
    )!;
    expect(chars).toMatchObject({
      cap: 'characters_per_job',
      limit: caps.maxCharsPerJob,
      unit: 'characters',
      resetsAt: null,
    });
    const minutes = capStop(
      caps,
      { ...job, units: caps.maxAudioMinPerJob + 1 },
      0,
      resetsAt,
    )!;
    expect(minutes).toMatchObject({
      cap: 'minutes_per_job',
      limit: caps.maxAudioMinPerJob,
      unit: 'minutes',
      resetsAt: null,
    });
    // Exactly at the cap is allowed; a job that is not counted in minutes has no minutes cap.
    expect(
      capStop(
        caps,
        { ...job, units: caps.maxAudioMinPerJob, costPoints: 1 },
        0,
        resetsAt,
      ),
    ).toBeNull();
    expect(
      capStop(
        caps,
        {
          ...job,
          per: 'use',
          units: caps.maxAudioMinPerJob + 5,
          costPoints: 1,
        },
        0,
        resetsAt,
      ),
    ).toBeNull();
  });
});

describe('the shortfall price (POINTS-03)', () => {
  const rate = config.points.pricePer1000Points;

  it('is the rate pro rata, rounded up to a whole kobo, never below the rate', () => {
    expect(shortfallPriceMinor(rate, 'NGN', 1000)).toBe(rate.kobo);
    expect(shortfallPriceMinor(rate, 'NGN', 1)).toBe(
      Math.ceil(rate.kobo / 1000),
    );
    for (const points of [1, 7, 333, 999, 1001, 12345]) {
      const price = shortfallPriceMinor(rate, 'NGN', points)!;
      expect(price * 1000).toBeGreaterThanOrEqual(points * rate.kobo);
      expect((price - 1) * 1000).toBeLessThan(points * rate.kobo);
    }
  });

  it('reads the dollar column for a dollar-billed person and refuses a price that does not fit a payment', () => {
    expect(shortfallPriceMinor(rate, 'USD', 1000)).toBe(rate.cents);
    expect(shortfallPriceMinor(rate, 'NGN', 2 ** 31 - 1)).toBeNull();
  });
});

describe('the shortfall target and goods', () => {
  it('names the points in the target and reads them back', () => {
    expect(shortfallTargetOf(250)).toBe('shortfall-250');
    expect(shortfallPointsOf('shortfall-250')).toBe(250);
    for (const bad of [
      'shortfall-0',
      'shortfall-01',
      'shortfall-',
      'pack-s',
      'shortfall-1e3',
      'shortfall-99999999999',
    ])
      expect(shortfallPointsOf(bad)).toBeNull();
  });

  it('keeps the points, rate and expiry as terms and refuses terms that are not goods', () => {
    const goods = { points: 40, per1000Minor: 100_000, expiryDays: 365 };
    expect(shortfallGoodsFromTerms(shortfallGoodsToTerms(goods))).toEqual(
      goods,
    );
    expect(() => shortfallGoodsFromTerms(undefined)).toThrow();
    expect(() => shortfallGoodsFromTerms({ v: 2, ...goods })).toThrow();
    expect(() =>
      shortfallGoodsFromTerms({ ...shortfallGoodsToTerms(goods), points: 0 }),
    ).toThrow();
  });
});
