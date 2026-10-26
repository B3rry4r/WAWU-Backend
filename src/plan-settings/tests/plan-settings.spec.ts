import { readFileSync } from 'node:fs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import type { PlansConfig } from '../../plans/plans-config';
import { LivePlansConfig } from '../live-plans-config';
import {
  buildRegistry,
  daysInMonths,
  LONG_DASH,
} from '../plan-setting-registry';
import { SettingInvalid } from '../plan-setting-types';
import {
  loadPlanSettingsDefaults,
  PLAN_SETTINGS_DEFAULTS_FILE,
  PlanSettingsDefaultsError,
} from '../plan-settings-defaults';
import { PlanSettingsService } from '../plan-settings.service';

/**
 * The registry, the seed check, the live plan and the cache (TIER-06, R-65),
 * with no database: the service is given a stand-in for the one table it reads.
 */

const seed = loadPlanSettingsDefaults();
const defs = buildRegistry(seed.plans, seed.extras);
const def = (key: string) => defs.find((d) => d.key === key)!;

type SeedFile = {
  provisional: Record<string, string>;
  values: Record<string, unknown>;
};
type Row = { key: string; value: unknown; updatedAt: Date };
const row = (key: string, value: unknown): Row => ({
  key,
  value,
  updatedAt: new Date('2026-10-17T10:00:00.000Z'),
});

function serviceWith(rows: () => Promise<Row[]>) {
  const prisma = { planSetting: { findMany: jest.fn(rows) } };
  return new PlanSettingsService(prisma as never, seed);
}

describe('the settings registry (TIER-06)', () => {
  it('builds from the real seed, with a key per figure and no key twice', () => {
    expect(defs.length).toBeGreaterThan(40);
    expect(new Set(defs.map((d) => d.key)).size).toBe(defs.length);
    for (const d of defs) {
      expect(d.label.length).toBeGreaterThan(0);
      expect(d.usedBy.length).toBeGreaterThan(0);
      expect(d.label + d.usedBy.join(' ')).not.toMatch(LONG_DASH);
    }
  });

  it('every default passes its own check', () => {
    for (const d of defs) {
      if (d.default !== null) expect(() => d.parse(d.default)).not.toThrow();
    }
  });

  it("holds the owner's launch figures (R-65)", () => {
    const get = (k: string) => def(k).default;
    expect(get('plan.tier.verify.price_kobo')).toBe(299_900);
    expect(get('plan.tier.plus.price_kobo')).toBe(599_900);
    expect(get('plan.tier.founding.price_kobo')).toBe(999_900);
    expect(get('plan.tier.verify.days')).toBe(365);
    expect(get('plan.tier.plus.days')).toBe(365);
    expect(get('plan.tier.founding.days')).toBe(365);
    expect(get('plan.extra_products.price_kobo')).toBe(150_000);
    expect(get('plan.extra_products.count')).toBe(5);
    expect(get('points.cash_rate_kobo_per_1000')).toBe(50_000);
    expect(get('points.expiry_months')).toBe(12);
    expect(get('points.daily_cap')).toBe(5000);
    expect(get('referral.hold_days')).toBe(7);
    const ladder = get('referral.multipliers') as { x: number }[];
    expect(ladder[0].x).toBe(1);
    expect(ladder[ladder.length - 1].x).toBe(3);
    expect(
      (get('referral.milestones') as { count: number; points: number }[])[0],
    ).toEqual({ count: 5, points: 500 });
    expect(get('name_check_per_hour')).toBe(30);
    expect(get('popular_community_min_members')).toBe(10);
    expect(
      [
        'community_credit_cost_photo',
        'community_credit_cost_video',
        'community_credit_cost_voice',
      ].map(get),
    ).toEqual([1, 3, 3]);
    expect(get('earnings.daily_move_floor_kobo')).toBe(20_000);
    expect(get('earnings.refused_review_hours')).toBe(72);
  });

  it('the seed file and the 12 month rule agree, so the file never says something else', () => {
    const lasts = daysInMonths(def('points.expiry_months').default as number);
    expect(seed.plans.points.boughtExpiryDays).toBe(lasts);
    for (const t of seed.plans.tiers) expect(t.bonusExpiryDays).toBe(lasts);
  });

  it('every figure the owner did not name carries a provisional marker with a reason', () => {
    const provisional = defs.filter((d) => d.provisional !== null);
    expect(provisional.length).toBeGreaterThan(20);
    for (const d of provisional) {
      const why =
        seed.extras.provisional[d.provisional!] ??
        seed.plans.provisional[d.provisional!];
      expect(why).toEqual(expect.any(String));
      expect(why).not.toMatch(LONG_DASH);
    }
    for (const key of [
      'plan.tier.founding.price_kobo',
      'plan.extra_products.price_kobo',
      'points.cash_rate_kobo_per_1000',
      'points.expiry_months',
      'points.daily_cap',
      'referral.multipliers',
      'referral.hold_days',
    ]) {
      expect(def(key).provisional).toBeNull();
    }
  });

  describe('a value is refused with its key and a reason', () => {
    const bad = (key: string, value: unknown) =>
      expect(() => def(key).parse(value)).toThrow(SettingInvalid);

    it.each([0, -1, -150000, 1.5, '150000', null, Number.NaN, 2 ** 31])(
      'a price of %p',
      (v) => bad('plan.extra_products.price_kobo', v),
    );

    it('zero is refused for a rate, a count, a cap and a length, and a percent may be 0', () => {
      bad('points.cash_rate_kobo_per_1000', 0);
      bad('plan.extra_products.count', 0);
      bad('points.daily_cap', 0);
      bad('points.expiry_months', 0);
      bad('referral.hold_days', 0);
      bad('plan.tier.founding.days', 0);
      bad('earnings.refused_review_hours', 0);
      expect(def('plan.tier.verify.pack_bonus_pct').parse(0)).toBe(0);
      bad('plan.tier.verify.pack_bonus_pct', 101);
    });

    it('a referral ladder starts at 1, climbs, and has at most 2 decimals', () => {
      const key = 'referral.multipliers';
      expect(
        def(key).parse([
          { min: 1, x: 1 },
          { min: 3, x: 1.25 },
        ]),
      ).toEqual([
        { min: 1, x: 1 },
        { min: 3, x: 1.25 },
      ]);
      bad(key, []);
      bad(key, [{ min: 2, x: 1 }]);
      bad(key, [{ min: 1, x: 0.5 }]);
      bad(key, [{ min: 1, x: 11 }]);
      bad(key, [{ min: 1, x: 1.234 }]);
      bad(key, [
        { min: 1, x: 2 },
        { min: 3, x: 1.5 },
      ]);
      bad(key, [
        { min: 1, x: 1 },
        { min: 1, x: 2 },
      ]);
      bad(key, [{ min: 1, x: 1, extra: true }]);
      bad(key, 'x3');
    });

    it('milestones climb and pay whole points', () => {
      const key = 'referral.milestones';
      expect(def(key).parse([{ count: 5, points: 500 }])).toEqual([
        { count: 5, points: 500 },
      ]);
      bad(key, []);
      bad(key, [{ count: 0, points: 500 }]);
      bad(key, [{ count: 5, points: 0 }]);
      bad(key, [
        { count: 5, points: 500 },
        { count: 5, points: 900 },
      ]);
    });

    it('pass lines are text without a long dash; the date and the time are real', () => {
      const lines = 'plan.event_pass.maker_pass_priority.benefits';
      expect(def(lines).parse([' A table to show your work '])).toEqual([
        'A table to show your work',
      ]);
      expect(def(lines).parse([])).toEqual([]);
      bad(lines, [`A table ${String.fromCharCode(0x2014)} for you`]);
      bad(lines, ['']);
      bad(lines, [1]);
      bad(lines, 'one line');
      bad(
        lines,
        Array.from({ length: 9 }, () => 'x'),
      );
      expect(def('plan.event_date').parse('2026-12-19')).toBe('2026-12-19');
      bad('plan.event_date', '2026-02-30');
      bad('plan.event_date', '19 Dec 2026');
      expect(def('tgif_notification_time').parse('07:30')).toBe('07:30');
      bad('tgif_notification_time', '7:30');
      bad('tgif_notification_time', '24:00');
    });
  });

  describe('the seed is checked whole at boot', () => {
    const extrasWith = (edit: (raw: SeedFile) => void) => {
      const raw = JSON.parse(
        readFileSync(PLAN_SETTINGS_DEFAULTS_FILE, 'utf8'),
      ) as SeedFile;
      edit(raw);
      const file = join(
        mkdtempSync(join(tmpdir(), 'plan-settings-')),
        'seed.json',
      );
      writeFileSync(file, JSON.stringify(raw));
      return file;
    };
    const load = (file: string) => () =>
      loadPlanSettingsDefaults(undefined, file);

    it('refuses a value its check refuses, a missing value, a stray key and a marker with no reason', () => {
      expect(
        load(
          extrasWith((r) => {
            r.values['points.expiry_months'] = 0;
          }),
        ),
      ).toThrow(/points\.expiry_months/);
      expect(
        load(
          extrasWith((r) => {
            delete r.values['referral.claim_days'];
          }),
        ),
      ).toThrow(/referral\.claim_days.*missing/);
      expect(
        load(
          extrasWith((r) => {
            r.values['not.a.setting'] = 1;
          }),
        ),
      ).toThrow(/not\.a\.setting/);
      expect(
        load(
          extrasWith((r) => {
            delete r.provisional['REF-CLAIM-DAYS'];
          }),
        ),
      ).toThrow(PlanSettingsDefaultsError);
    });
  });
});

describe('the live plan and its cache (TIER-06)', () => {
  it('carries every field of the plan the file reads', () => {
    const live = new LivePlansConfig(serviceWith(() => Promise.resolve([])));
    for (const key of Object.keys(seed.plans)) {
      expect(key in live).toBe(true);
      expect(live[key as keyof PlansConfig]).toEqual(
        serviceWith(() => Promise.resolve([])).current()[
          key as keyof PlansConfig
        ],
      );
    }
  });

  it('with no saved row the plan is the seed, and the seed is not touched', async () => {
    const svc = serviceWith(() => Promise.resolve([]));
    await svc.refresh();
    expect(svc.current().tiers.map((t) => t.price.kobo)).toEqual(
      seed.plans.tiers.map((t) => t.price.kobo),
    );
    expect(svc.describe().settings.every((s) => s.source === 'default')).toBe(
      true,
    );
  });

  it('a saved value reaches the plan and the next read, with no restart', async () => {
    let rows: Row[] = [];
    const svc = serviceWith(() => Promise.resolve(rows));
    const live = new LivePlansConfig(svc);
    const before = live.extraProducts.price.kobo;
    rows = [
      row('plan.extra_products.price_kobo', 175_000),
      row('points.cash_rate_kobo_per_1000', 60_000),
      row('points.daily_cap', 4000),
      row('points.expiry_months', 6),
      row('plan.tier.founding.price_kobo', 450_000),
      row('plan.pack.m.price_kobo', 240_000),
      row('referral.hold_days', 10),
      row('plan.event_date', '2026-12-19'),
      row('plan.event_pass.maker_pass_priority.benefits', ['One line']),
    ];
    await svc.refresh();
    expect(before).not.toBe(175_000);
    expect(live.extraProducts.price.kobo).toBe(175_000);
    expect(live.cashOut.per1000Points.kobo).toBe(60_000);
    expect(live.caps.dailyPointsPerUser).toBe(4000);
    expect(live.tiers.find((t) => t.id === 'founding')!.price.kobo).toBe(
      450_000,
    );
    expect(live.packs.find((p) => p.id === 'm')!.price.kobo).toBe(240_000);
    expect(live.referral.holdDays).toBe(10);
    expect(live.eventDate).toBe('2026-12-19');
    expect(
      live.eventPasses.find((p) => p.id === 'maker_pass_priority')!.benefits,
    ).toEqual(['One line']);
    // Six months moves every lot, bonus and bought.
    const lasts = daysInMonths(6);
    expect(live.points.boughtExpiryDays).toBe(lasts);
    for (const t of live.tiers) expect(t.bonusExpiryDays).toBe(lasts);
    // Dollar prices are not settings and are left as the file has them.
    expect(live.tiers.map((t) => t.price.cents)).toEqual(
      seed.plans.tiers.map((t) => t.price.cents),
    );
    const view = svc.describe().settings;
    expect(
      view.find((s) => s.key === 'plan.extra_products.price_kobo'),
    ).toMatchObject({
      source: 'set',
      value: 175_000,
      default: seed.plans.extraProducts.price.kobo,
      updatedAt: '2026-10-17T10:00:00.000Z',
    });
    // Putting the row back reads the default again.
    rows = [];
    await svc.refresh();
    expect(live.extraProducts.price.kobo).toBe(before);
  });

  it('a row that fails its own check, or names no setting, is skipped and the default is used', async () => {
    const svc = serviceWith(() =>
      Promise.resolve([
        row('plan.extra_products.price_kobo', 0),
        row('plan.tier.founding.price_kobo', 'free'),
        row('no.such.setting', 5),
        row('points.daily_cap', 3000),
      ]),
    );
    const errors = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    await svc.refresh();
    expect(svc.current().extraProducts.price.kobo).toBe(
      seed.plans.extraProducts.price.kobo,
    );
    expect(
      svc.current().tiers.find((t) => t.id === 'founding')!.price.kobo,
    ).toBe(seed.plans.tiers.find((t) => t.id === 'founding')!.price.kobo);
    expect(svc.current().caps.dailyPointsPerUser).toBe(3000);
    expect(errors).toHaveBeenCalledTimes(3);
  });

  it('a failed load keeps the plan already held', async () => {
    let fail = false;
    const svc = serviceWith(() =>
      fail
        ? Promise.reject(new Error('database is down'))
        : Promise.resolve([row('points.daily_cap', 3000)]),
    );
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await svc.refresh();
    fail = true;
    await svc.refresh();
    expect(svc.current().caps.dailyPointsPerUser).toBe(3000);
  });

  it('a load that started earlier never replaces a later one', async () => {
    const waiting: ((rows: Row[]) => void)[] = [];
    const svc = serviceWith(
      () => new Promise<Row[]>((resolve) => waiting.push(resolve)),
    );
    const first = svc.refresh();
    const second = svc.refresh();
    waiting[1]([row('points.daily_cap', 2000)]);
    await second;
    waiting[0]([row('points.daily_cap', 1000)]);
    await first;
    expect(svc.current().caps.dailyPointsPerUser).toBe(2000);
  });

  it('the typed readers for the tasks that use a setting say so for a wrong kind or key', () => {
    const svc = serviceWith(() => Promise.resolve([]));
    expect(svc.number('name_check_per_hour')).toBe(30);
    expect(svc.text('tgif_notification_time')).toBe('07:00');
    expect(() => svc.number('tgif_notification_time')).toThrow(/number/);
    expect(() => svc.text('name_check_per_hour')).toThrow(/text/);
    expect(() => svc.value('no.such')).toThrow(/no setting/);
  });
});
