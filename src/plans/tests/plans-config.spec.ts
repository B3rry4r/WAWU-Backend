// These specs break copies of a JSON file field by field, so they reach into
// untyped JSON on purpose.
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadPlansConfig,
  parsePlansConfig,
  PLANS_CONFIG_FILE,
  PlansConfigError,
  priceIn,
  countIn,
  type PlansConfig,
} from '../plans-config';
import { tierStateAt } from '../maker-tier.service';
import { planIn } from '../plans.service';

/**
 * TIER-01: the one config file, checked whole at boot. These specs read the
 * shipped file and break copies of it; they never pin its figures (the owner
 * replaces them, R-43), only how they are read.
 */

const shipped = (): Record<string, unknown> =>
  JSON.parse(readFileSync(PLANS_CONFIG_FILE, 'utf8')) as Record<
    string,
    unknown
  >;

/** A copy of the shipped file with one change made by `edit`. */
function broken(edit: (raw: any) => void): unknown {
  const raw = shipped();
  edit(raw);
  return raw;
}

/** The message a broken copy stops boot with. */
function stop(edit: (raw: any) => void): string {
  try {
    parsePlansConfig(broken(edit), PLANS_CONFIG_FILE);
  } catch (e) {
    expect(e).toBeInstanceOf(PlansConfigError);
    return (e as Error).message;
  }
  throw new Error('the broken copy was accepted');
}

describe('plans.config.json (TIER-01)', () => {
  let config: PlansConfig;
  beforeAll(() => {
    config = loadPlansConfig();
  });

  it('the shipped file loads and passes every check', () => {
    expect(config.tiers.length).toBeGreaterThan(0);
    expect(config.packs.length).toBeGreaterThan(0);
    expect(config.actions.length).toBeGreaterThan(0);
  });

  it('every price is a whole number of kobo and of cents, above zero', () => {
    const prices = [
      ...config.tiers.map((t) => t.price),
      config.extraProducts.price,
      ...config.packs.map((p) => p.price),
      config.checkoutBump.price,
      config.points.pricePer1000Points,
      config.cashOut.per1000Points,
    ];
    for (const p of prices) {
      expect(Number.isSafeInteger(p.kobo) && p.kobo > 0).toBe(true);
      expect(Number.isSafeInteger(p.cents) && p.cents > 0).toBe(true);
    }
  });

  it('carries one marker per provisional value, the same list as plans-config.ts', () => {
    const source = readFileSync(join(__dirname, '../plans-config.ts'), 'utf8');
    const markers = [...source.matchAll(/PROVISIONAL\(([A-Z0-9-]+),/g)].map(
      (m) => m[1],
    );
    expect(markers.sort()).toEqual(Object.keys(config.provisional).sort());
    // The file covers itself, the two values the brief does not give, and
    // the ending window.
    expect(markers).toEqual(
      expect.arrayContaining([
        'PLAN-PRICES',
        'PLAN-CASHOUT-MINIMUM',
        'PLAN-BOUGHT-POINTS-DAYS',
        'PLAN-ENDING-DAYS',
      ]),
    );
  });

  describe('a malformed or incomplete file stops boot, naming the field', () => {
    it.each<[string, (raw: any) => void, string]>([
      [
        'a tier price in fractions of a kobo',
        (r) => (r.tiers[1].price.kobo = 3000.5),
        'tiers[1].price.kobo must be a whole number of 1 or more (it is 3000.5)',
      ],
      [
        'a price written as text',
        (r) => (r.packs[0].price.cents = '300'),
        'packs[0].price.cents must be a whole number of 1 or more (it is "300")',
      ],
      [
        'a negative price',
        (r) => (r.extra_products.price.kobo = -1),
        'extra_products.price.kobo must be a whole number of 1 or more',
      ],
      [
        'a free tier',
        (r) => (r.tiers[0].price.cents = 0),
        'tiers[0].price.cents must be a whole number of 1 or more (it is 0)',
      ],
      [
        'a missing dollar price',
        (r) => delete r.checkout_bump.price.cents,
        'checkout_bump.price.cents is missing',
      ],
      ['a missing section', (r) => delete r.caps, 'caps is missing'],
      [
        'a misspelt field',
        (r) => {
          r.tiers[2].bonus_point = r.tiers[2].bonus_points;
          delete r.tiers[2].bonus_points;
        },
        'tiers[2].bonus_point is not a known field',
      ],
      [
        'a tier with no product count',
        (r) => delete r.tiers[0].products,
        'tiers[0].products is missing',
      ],
      [
        'an event pass nobody defined',
        (r) => (r.tiers[0].event_pass = 'front_row'),
        'tiers[0].event_pass must be one of',
      ],
      [
        'two tiers with one id',
        (r) => (r.tiers[1].id = r.tiers[0].id),
        `tiers[1].id repeats`,
      ],
      [
        'a preselected tier that does not exist',
        (r) => (r.preselected_tier = 'gold'),
        'preselected_tier must be one of',
      ],
      [
        'a referral base for a tier that does not exist',
        (r) => (r.referral.base_points.gold = 1),
        'referral.base_points.gold names no tier',
      ],
      [
        'a tier with no referral base',
        (r) => delete r.referral.base_points[r.tiers[0].id],
        'is missing (every tier needs one)',
      ],
      [
        'referral levels out of order',
        (r) => (r.referral.levels[2].min = r.referral.levels[1].min),
        'referral.levels[2].min must be above the level before',
      ],
      [
        'a percent above 100',
        (r) => (r.tiers[2].pack_bonus_pct = 101),
        'tiers[2].pack_bonus_pct must be a whole number from 0 to 100',
      ],
      [
        'an action counted per something unknown',
        (r) => (r.action_points.sfx.per = 'hour'),
        'action_points.sfx.per must be one of',
      ],
      [
        'an action with fractional points',
        (r) => (r.action_points.sfx.points = 7.5),
        'action_points.sfx.points must be a whole number of 1 or more',
      ],
      [
        'a cap of zero',
        (r) => (r.caps.max_chars_per_job = 0),
        'caps.max_chars_per_job must be a whole number of 1 or more',
      ],
      [
        'no tiers at all',
        (r) => (r.tiers = []),
        'tiers must be a list with at least one entry',
      ],
      [
        'a name with an em-dash',
        (r) => (r.tiers[0].name = 'Verify \u2014 basic'),
        'tiers[0].name must not contain an em-dash',
      ],
      [
        'a provisional marker without a reason',
        (r) => (r.provisional['PLAN-PRICES'] = ''),
        'provisional.PLAN-PRICES must be text',
      ],
      [
        'an empty object',
        (r) => {
          for (const k of Object.keys(r)) delete r[k];
        },
        'provisional is missing',
      ],
    ])('%s', (_name, edit, expected) => {
      const message = stop(edit);
      expect(message).toContain(expected);
      expect(message.startsWith('plans.config.json: ')).toBe(true);
    });

    it('a file that is not JSON stops boot and says so', () => {
      const dir = mkdtempSync(join(tmpdir(), 'plans-'));
      const file = join(dir, 'plans.config.json');
      writeFileSync(file, '{ "tiers": [ ');
      expect(() => loadPlansConfig(file)).toThrow(
        /plans\.config\.json: \(the file\) is not valid JSON/,
      );
    });

    it('a missing file stops boot and says so', () => {
      const file = join(
        mkdtempSync(join(tmpdir(), 'plans-')),
        'plans.config.json',
      );
      expect(() => loadPlansConfig(file)).toThrow(
        'plans.config.json: (the file) cannot be read. Fix the file and restart.',
      );
    });
  });

  describe('one currency per person', () => {
    it('priceIn picks kobo for NGN and cents for USD', () => {
      const price = config.tiers[0].price;
      expect(priceIn(price, 'NGN')).toBe(price.kobo);
      expect(priceIn(price, 'USD')).toBe(price.cents);
      const pts = config.packs[0].points;
      expect(countIn(pts, 'NGN')).toBe(pts.NGN);
      expect(countIn(pts, 'USD')).toBe(pts.USD);
    });

    it('the plan in naira carries only kobo prices, and in dollars only cents', () => {
      for (const currency of ['NGN', 'USD'] as const) {
        const plan = planIn(config, currency);
        const pick = (p: { kobo: number; cents: number }) =>
          currency === 'NGN' ? p.kobo : p.cents;
        expect(plan.currency).toBe(currency);
        expect(plan.tiers.map((t) => t.priceMinor)).toEqual(
          config.tiers.map((t) => pick(t.price)),
        );
        expect(plan.packs.map((p) => p.priceMinor)).toEqual(
          config.packs.map((p) => pick(p.price)),
        );
        expect(plan.packs.map((p) => p.points)).toEqual(
          config.packs.map((p) => p.points[currency]),
        );
        expect(plan.extraProducts.priceMinor).toBe(
          pick(config.extraProducts.price),
        );
        expect(plan.checkoutBump.priceMinor).toBe(
          pick(config.checkoutBump.price),
        );
        expect(plan.checkoutBump.points).toBe(
          config.checkoutBump.points[currency],
        );
      }
    });

    it('marks exactly the configured tier as preselected', () => {
      const plan = planIn(config, 'NGN');
      expect(plan.tiers.filter((t) => t.preselected).map((t) => t.id)).toEqual([
        config.preselectedTier,
      ]);
    });
  });

  describe("a tier's state", () => {
    const now = new Date('2026-12-01T12:00:00Z');
    const days = (n: number) => new Date(now.getTime() + n * 86_400_000);

    it('is active, then ending inside the window, then ended at its end', () => {
      const w = config.tierEndingDays;
      expect(tierStateAt(days(w + 1), now, w)).toBe('active');
      expect(tierStateAt(new Date(days(w).getTime() + 1), now, w)).toBe(
        'active',
      );
      expect(tierStateAt(days(w), now, w)).toBe('ending');
      expect(tierStateAt(new Date(now.getTime() + 1), now, w)).toBe('ending');
      expect(tierStateAt(now, now, w)).toBe('ended');
      expect(tierStateAt(days(-1), now, w)).toBe('ended');
    });
  });
});
