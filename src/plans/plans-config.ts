import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { BillingCurrency } from '../../generated/prisma/enums';

/**
 * THE MAKER PLAN'S FIGURES: ONE FILE, READ EVERYWHERE (TIER-01, R-43).
 *
 * Every price, product count, points amount, expiry, cost and cap of the
 * owner's 5 Oct plan (Developer Brief v2.0, section 2) is in
 * `src/plans/plans.config.json`, and nowhere else: "until then the plan's
 * figures are config values, never facts" (R-43). Code reads them through
 * the PLANS_CONFIG provider; a spec (plans-figures.spec.ts) fails when one
 * of them is written into this module's code or into a string anywhere in
 * `src/`.
 *
 * Read once, at boot, and checked whole: a file that is not JSON, a field
 * that is missing, misspelt, of the wrong kind or out of range stops the
 * server with a message naming the field (`tiers[1].price.kobo must be a
 * whole number of 1 or more`). Changing a figure is editing the file and
 * restarting; no code changes.
 *
 * Money is in minor units, whole numbers only: `kobo` for people billed in
 * naira, `cents` for people billed in dollars (R-21: never naira or dollar
 * decimals, never a float). Points are whole numbers of points.
 *
 * The values the file holds are example values until the owner sends the
 * final ones; the file's own `provisional` object says why for each of these
 * markers, and plans-config.spec.ts keeps the two lists equal:
 *
 * PROVISIONAL(PLAN-PRICES, owner=YOU, why=R-43 the owner sends final prices; every figure in plans.config.json is an example value until then)
 * PROVISIONAL(PLAN-CASHOUT-MINIMUM, owner=YOU, why=the brief gives no cash-out minimum and PT6 draws one; the file's value is the number of points the rate is quoted per)
 * PROVISIONAL(PLAN-BOUGHT-POINTS-DAYS, owner=YOU, why=the brief does not say how long bought points last; the file's value is the longest period the plan uses)
 * PROVISIONAL(PLAN-ENDING-DAYS, owner=YOU, why=VF14 draws a tier that is ending but no window; the file's value gives a week to renew)
 */

/** The Nest token the checked config is provided under. */
export const PLANS_CONFIG = 'PLANS_CONFIG';

/** A price in both billing currencies' minor units. */
export interface MinorPrice {
  /** Naira, in kobo. */
  kobo: number;
  /** Dollars, in cents. */
  cents: number;
}

/** A count that differs by billing currency (a dollar pack holds more points). */
export interface PerCurrency {
  NGN: number;
  USD: number;
}

export interface PlanEventPass {
  id: string;
  name: string;
}

export interface PlanBadge {
  id: string;
  /** Founding Maker's badge carries a number (VF7). */
  numbered: boolean;
}

export interface PlanTier {
  id: string;
  name: string;
  /** How long one purchase lasts. */
  days: number;
  /** Products the tier lets a person publish. */
  products: number;
  bonusPoints: number;
  /** How long the bonus points lot lasts. */
  bonusExpiryDays: number;
  price: MinorPrice;
  /** An `event_passes` id. */
  eventPass: string;
  badge: PlanBadge;
  /** Extra points on points packs bought while on this tier, in percent. */
  packBonusPct: number;
  /** The tier includes the first Voice Intro. */
  firstVoiceIntro: boolean;
}

export interface PlanPack {
  id: string;
  points: PerCurrency;
  price: MinorPrice;
}

/**
 * The largest value a Postgres INTEGER column holds. Counts and points are
 * copied into such columns (`MakerTier.productsIncluded`, `pointsIncluded`,
 * `extraProducts`), so the file may not hold a bigger whole number: it would
 * boot and then fail at the first purchase.
 */
export const INT4_MAX = 2_147_483_647;

/**
 * Every AI action the plan prices (brief section 2, `action_points`), in the
 * file's order. The file must price each one, and only these: the points
 * service (POINTS-03) charges by these ids, so a missing one would be an
 * action with no price.
 */
export const PLAN_ACTIONS = [
  'say_my_name',
  'voice_intro',
  'voiceover_per_min',
  'quick_voice_per_min',
  'captions_per_min',
  'clean_audio_per_min',
  'music_per_track',
  'sfx',
  'dub_standard_per_min_lang',
  'dub_premium_per_min_lang',
  'receptionist_message',
  'receptionist_voice_per_min',
] as const;
export type PlanActionId = (typeof PLAN_ACTIONS)[number];

/** What an action's points are counted per. */
export const ACTION_UNITS = [
  'use',
  'minute',
  'track',
  'message',
  'minute_per_language',
] as const;
export type ActionUnit = (typeof ACTION_UNITS)[number];

export interface PlanAction {
  /** The key in `action_points`. */
  id: string;
  points: number;
  per: ActionUnit;
}

export interface PlanReferralLevel {
  /** Verified referrals needed to reach the level. */
  min: number;
  /** The multiplier on the base points. */
  x: number;
}

export interface PlanReferralMilestone {
  count: number;
  points: number;
}

/**
 * One event registration offer (JOIN-01, R-48): what a person at an event
 * pays to join the waiting list, and the tier that payment becomes when they
 * sign up in the app. The price is `priceKobo` and nowhere else.
 */
export interface EventOffer {
  /** Lower-case letters, digits and hyphens, for example `event-oct-2026`. */
  id: string;
  name: string;
  /** Whole kobo. Naira only. */
  priceKobo: number;
  /** A `tiers` id: the plan the payment turns into. */
  tier: string;
  /** How many days the plan lasts; the tier's own `days` when the file omits it. */
  tierDays: number;
  /** Registration opens at this instant. */
  openFrom: Date;
  /** Registration closes at this instant. */
  openUntil: Date;
}

export interface PlansConfig {
  /** Marker id to why, as the file states it. */
  provisional: Readonly<Record<string, string>>;
  /** Lowest first: the reader shows a person's highest pass. */
  eventPasses: readonly PlanEventPass[];
  tiers: readonly PlanTier[];
  /** Event registration offers (JOIN-01); the list may be empty. */
  eventOffers: readonly EventOffer[];
  /** The tier VF5 shows selected. */
  preselectedTier: string;
  /** A tier is `ending` this many days or fewer before it ends (VF14). */
  tierEndingDays: number;
  extraProducts: { count: number; price: MinorPrice };
  packs: readonly PlanPack[];
  checkoutBump: { points: PerCurrency; price: MinorPrice };
  points: {
    /** The pack rate: what 1,000 points cost when a shortfall is paid from the wallet. */
    pricePer1000Points: MinorPrice;
    /** How long bought points last. */
    boughtExpiryDays: number;
  };
  cashOut: {
    /** What 1,000 points pay into the wallet. */
    per1000Points: MinorPrice;
    /** The fewest points that can be converted at once. */
    minimumPoints: number;
  };
  /** In the file's order. */
  actions: readonly PlanAction[];
  caps: {
    dailyPointsPerUser: number;
    maxCharsPerJob: number;
    maxAudioMinPerJob: number;
  };
  referral: {
    oneLevelOnly: boolean;
    referrerMustBeVerified: boolean;
    holdDays: number;
    /** Tier id to the points a referral who buys it earns. */
    basePoints: Readonly<Record<string, number>>;
    levels: readonly PlanReferralLevel[];
    milestones: readonly PlanReferralMilestone[];
  };
}

/**
 * The config file is unusable. Stops the server at boot; the message names
 * the file and the field.
 */
export class PlansConfigError extends Error {
  constructor(
    readonly field: string,
    problem: string,
    file: string,
  ) {
    super(`${basename(file)}: ${field} ${problem}. Fix the file and restart.`);
    this.name = 'PlansConfigError';
  }
}

function repoRoot(): string {
  let dir = __dirname;
  while (!existsSync(join(dir, 'package.json'))) {
    const up = dirname(dir);
    if (up === dir)
      throw new Error(
        'Plans config: package.json not found above ' + __dirname,
      );
    dir = up;
  }
  return dir;
}

/**
 * Where the file is: in the source tree, read at boot, so the built server
 * (`dist/`) and the specs read the same file and a deploy that changes it
 * needs no build step to pick it up (the source is on the server, as the
 * TGIF book is).
 */
export const PLANS_CONFIG_FILE = join(
  repoRoot(),
  'src',
  'plans',
  'plans.config.json',
);

/** Picks the price a person billed in `currency` pays. The one place that chooses. */
export function priceIn(price: MinorPrice, currency: BillingCurrency): number {
  return currency === 'USD' ? price.cents : price.kobo;
}

/** Picks the count for a person billed in `currency`. */
export function countIn(count: PerCurrency, currency: BillingCurrency): number {
  return currency === 'USD' ? count.USD : count.NGN;
}

/** The tier with this id, or null when the config no longer has it. */
export function tierById(config: PlansConfig, id: string): PlanTier | null {
  return config.tiers.find((t) => t.id === id) ?? null;
}

/** Reads and checks the file. Throws PlansConfigError naming the bad field. */
export function loadPlansConfig(file: string = PLANS_CONFIG_FILE): PlansConfig {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new PlansConfigError('(the file)', 'cannot be read', file);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new PlansConfigError(
      '(the file)',
      `is not valid JSON (${(e as Error).message})`,
      file,
    );
  }
  // JSON.parse keeps the last of two equal keys, so a price written twice
  // (an edit that left the old line in place) would boot on whichever came
  // second. The file is refused instead, naming the key.
  const repeated = repeatedKey(text);
  if (repeated !== null)
    throw new PlansConfigError(repeated, 'is written twice', file);
  return parsePlansConfig(raw, file);
}

/**
 * The path of the first key written twice in one object (`tiers[0].price.kobo`),
 * or null. Runs on text JSON.parse has already accepted, so it only has to
 * walk valid JSON. Keys are compared as JSON decodes them (`"kobo"` and
 * `"\u006bobo"` are the same key).
 */
export function repeatedKey(text: string): string | null {
  let i = 0;
  const end = text.length;
  const space = () => {
    while (i < end && ' \t\n\r'.includes(text[i])) i++;
  };
  const str = (): string => {
    const start = i;
    i++;
    while (i < end && text[i] !== '"') {
      if (text[i] === '\\') i++; // an escape: skip the escaped character too
      i++;
    }
    i++;
    return JSON.parse(text.slice(start, i)) as string;
  };
  const value = (path: string): string | null => {
    space();
    const ch = text[i];
    if (ch === '{') {
      i++;
      space();
      if (text[i] === '}') {
        i++;
        return null;
      }
      const seen = new Set<string>();
      while (i < end) {
        space();
        const key = str();
        const at = path ? `${path}.${key}` : key;
        if (seen.has(key)) return at;
        seen.add(key);
        space();
        i++; // the colon
        const inner = value(at);
        if (inner !== null) return inner;
        space();
        if (text[i++] !== ',') return null; // the closing brace
      }
      return null;
    }
    if (ch === '[') {
      i++;
      space();
      if (text[i] === ']') {
        i++;
        return null;
      }
      for (let n = 0; i < end; n++) {
        const inner = value(`${path}[${n}]`);
        if (inner !== null) return inner;
        space();
        if (text[i++] !== ',') return null; // the closing bracket
      }
      return null;
    }
    if (ch === '"') {
      str();
      return null;
    }
    while (i < end && !' \t\n\r,]}'.includes(text[i])) i++;
    return null;
  };
  return value('');
}

// ─── the checks ────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;

class Check {
  constructor(private readonly file: string) {}

  fail(path: string, problem: string): never {
    throw new PlansConfigError(path || '(the file)', problem, this.file);
  }

  /**
   * An object with exactly these keys: one missing or one unknown stops it.
   * `optional` keys may be left out but are still known.
   */
  object(
    v: unknown,
    path: string,
    keys: readonly string[],
    optional: readonly string[] = [],
  ): Obj {
    if (typeof v !== 'object' || v === null || Array.isArray(v))
      this.fail(path, 'must be an object');
    const o = v as Obj;
    for (const k of Object.keys(o))
      if (!keys.includes(k) && !optional.includes(k))
        this.fail(join2(path, k), 'is not a known field');
    for (const k of keys)
      if (!(k in o)) this.fail(join2(path, k), 'is missing');
    return o;
  }

  /**
   * An object whose keys are ids (or match `keys`), each value checked by
   * `each`.
   */
  map<T>(
    v: unknown,
    path: string,
    each: (value: unknown, path: string) => T,
    keys?: { pattern: RegExp; like: string },
  ): Record<string, T> {
    if (typeof v !== 'object' || v === null || Array.isArray(v))
      this.fail(path, 'must be an object');
    const out: Record<string, T> = {};
    for (const [k, value] of Object.entries(v as Obj)) {
      if (!keys) this.id(k, `${join2(path, k)} (the key)`);
      else if (!keys.pattern.test(k))
        this.fail(join2(path, k), `must be a key like ${keys.like}`);
      out[k] = each(value, join2(path, k));
    }
    return out;
  }

  list(v: unknown, path: string): unknown[] {
    if (!Array.isArray(v) || v.length === 0)
      this.fail(path, 'must be a list with at least one entry');
    return v as unknown[];
  }

  whole(v: unknown, path: string, min: number): number {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min)
      this.fail(
        path,
        `must be a whole number of ${min} or more (it is ${show(v)})`,
      );
    if (v > INT4_MAX)
      this.fail(
        path,
        `must be at most ${INT4_MAX}, the most a whole-number column holds (it is ${v})`,
      );
    return v;
  }

  /** A multiplier: a finite number of 1 or more. */
  multiplier(v: unknown, path: string): number {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 1)
      this.fail(path, `must be a number of 1 or more (it is ${show(v)})`);
    return v;
  }

  percent(v: unknown, path: string): number {
    const n = this.whole(v, path, 0);
    if (n > 100)
      this.fail(path, `must be a whole number from 0 to 100 (it is ${n})`);
    return n;
  }

  bool(v: unknown, path: string): boolean {
    if (typeof v !== 'boolean')
      this.fail(path, `must be true or false (it is ${show(v)})`);
    return v;
  }

  text(v: unknown, path: string): string {
    if (typeof v !== 'string' || v.trim() === '' || v.trim() !== v)
      this.fail(path, 'must be text, not empty, with no spaces around it');
    if (v.includes('\u2014'))
      this.fail(path, 'must not contain an em-dash (R-5)');
    return v;
  }

  id(v: unknown, path: string): string {
    if (typeof v !== 'string' || !/^[a-z][a-z0-9_]*$/.test(v))
      this.fail(
        path,
        `must be an id of lower-case letters, digits and _ (it is ${show(v)})`,
      );
    return v;
  }

  /** An offer id: lower-case letters, digits and hyphens, starting with a letter. */
  offerId(v: unknown, path: string): string {
    if (typeof v !== 'string' || !/^[a-z][a-z0-9-]*$/.test(v) || v.length > 60)
      this.fail(
        path,
        `must be an id of lower-case letters, digits and - (it is ${show(v)})`,
      );
    return v;
  }

  /**
   * A moment with its UTC offset written out (`2026-10-10T00:00:00+01:00`),
   * so no reader has to guess a time zone.
   */
  instant(v: unknown, path: string): Date {
    if (
      typeof v !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(
        v,
      )
    )
      this.fail(
        path,
        `must be a date and time with its offset, like 2026-10-10T00:00:00+01:00 (it is ${show(v)})`,
      );
    const d = new Date(v);
    if (Number.isNaN(d.getTime()))
      this.fail(path, `is not a real date and time (it is ${show(v)})`);
    return d;
  }

  oneOf<T extends string>(v: unknown, path: string, allowed: readonly T[]): T {
    if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v))
      this.fail(
        path,
        `must be one of ${allowed.join(', ')} (it is ${show(v)})`,
      );
    return v as T;
  }

  unique(ids: readonly string[], path: string): void {
    const seen = new Set<string>();
    ids.forEach((id, i) => {
      if (seen.has(id)) this.fail(`${path}[${i}].id`, `repeats "${id}"`);
      seen.add(id);
    });
  }

  price(v: unknown, path: string): MinorPrice {
    const o = this.object(v, path, ['kobo', 'cents']);
    return {
      kobo: this.whole(o.kobo, `${path}.kobo`, 1),
      cents: this.whole(o.cents, `${path}.cents`, 1),
    };
  }

  perCurrency(v: unknown, path: string): PerCurrency {
    const o = this.object(v, path, ['NGN', 'USD']);
    return {
      NGN: this.whole(o.NGN, `${path}.NGN`, 1),
      USD: this.whole(o.USD, `${path}.USD`, 1),
    };
  }
}

function join2(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

function show(v: unknown): string {
  if (v === undefined) return 'missing';
  const s = JSON.stringify(v);
  return s.length > 40 ? `${s.slice(0, 40)}...` : s;
}

const TOP = [
  'provisional',
  'event_passes',
  'tiers',
  'event_offers',
  'preselected_tier',
  'tier_ending_days',
  'extra_products',
  'packs',
  'checkout_bump',
  'points',
  'cash_out',
  'action_points',
  'caps',
  'referral',
] as const;

const OFFER_KEYS = [
  'id',
  'name',
  'price_kobo',
  'tier',
  'open_from',
  'open_until',
] as const;

const TIER_KEYS = [
  'id',
  'name',
  'days',
  'products',
  'bonus_points',
  'bonus_expiry_days',
  'price',
  'event_pass',
  'badge',
  'pack_bonus_pct',
  'first_voice_intro',
] as const;

/** Checks a parsed file. Exported for the specs; the server uses loadPlansConfig. */
export function parsePlansConfig(raw: unknown, file: string): PlansConfig {
  const c = new Check(file);
  const top = c.object(raw, '', TOP);

  const provisional = c.map(
    top.provisional,
    'provisional',
    (v, p) => c.text(v, p),
    { pattern: /^PLAN-[A-Z0-9-]+$/, like: 'PLAN-PRICES' },
  );

  const eventPasses = c.list(top.event_passes, 'event_passes').map((v, i) => {
    const p = `event_passes[${i}]`;
    const o = c.object(v, p, ['id', 'name']);
    return { id: c.id(o.id, `${p}.id`), name: c.text(o.name, `${p}.name`) };
  });
  c.unique(
    eventPasses.map((e) => e.id),
    'event_passes',
  );
  const passIds = eventPasses.map((e) => e.id);

  const tiers = c.list(top.tiers, 'tiers').map((v, i): PlanTier => {
    const p = `tiers[${i}]`;
    const o = c.object(v, p, TIER_KEYS);
    const badge = c.object(o.badge, `${p}.badge`, ['id', 'numbered']);
    return {
      id: c.id(o.id, `${p}.id`),
      name: c.text(o.name, `${p}.name`),
      days: c.whole(o.days, `${p}.days`, 1),
      products: c.whole(o.products, `${p}.products`, 1),
      bonusPoints: c.whole(o.bonus_points, `${p}.bonus_points`, 0),
      bonusExpiryDays: c.whole(
        o.bonus_expiry_days,
        `${p}.bonus_expiry_days`,
        1,
      ),
      price: c.price(o.price, `${p}.price`),
      eventPass: c.oneOf(o.event_pass, `${p}.event_pass`, passIds),
      badge: {
        id: c.id(badge.id, `${p}.badge.id`),
        numbered: c.bool(badge.numbered, `${p}.badge.numbered`),
      },
      packBonusPct: c.percent(o.pack_bonus_pct, `${p}.pack_bonus_pct`),
      firstVoiceIntro: c.bool(o.first_voice_intro, `${p}.first_voice_intro`),
    };
  });
  c.unique(
    tiers.map((t) => t.id),
    'tiers',
  );
  const tierIds = tiers.map((t) => t.id);

  if (!Array.isArray(top.event_offers))
    c.fail('event_offers', 'must be a list (it may be empty)');
  const eventOffers = (top.event_offers as unknown[]).map(
    (v, i): EventOffer => {
      const p = `event_offers[${i}]`;
      const o = c.object(v, p, OFFER_KEYS, ['tier_days']);
      const tier = c.oneOf(o.tier, `${p}.tier`, tierIds);
      const openFrom = c.instant(o.open_from, `${p}.open_from`);
      const openUntil = c.instant(o.open_until, `${p}.open_until`);
      if (openUntil.getTime() <= openFrom.getTime())
        c.fail(`${p}.open_until`, 'must be after open_from');
      return {
        id: c.offerId(o.id, `${p}.id`),
        name: c.text(o.name, `${p}.name`),
        priceKobo: c.whole(o.price_kobo, `${p}.price_kobo`, 1),
        tier,
        tierDays:
          o.tier_days === undefined
            ? tiers.find((t) => t.id === tier)!.days
            : c.whole(o.tier_days, `${p}.tier_days`, 1),
        openFrom,
        openUntil,
      };
    },
  );
  eventOffers.forEach((offer, i) => {
    if (eventOffers.findIndex((x) => x.id === offer.id) !== i)
      c.fail(`event_offers[${i}].id`, `repeats "${offer.id}"`);
  });

  const preselectedTier = c.oneOf(
    top.preselected_tier,
    'preselected_tier',
    tierIds,
  );
  const tierEndingDays = c.whole(top.tier_ending_days, 'tier_ending_days', 1);

  const extra = c.object(top.extra_products, 'extra_products', [
    'count',
    'price',
  ]);
  const extraProducts = {
    count: c.whole(extra.count, 'extra_products.count', 1),
    price: c.price(extra.price, 'extra_products.price'),
  };

  const packs = c.list(top.packs, 'packs').map((v, i): PlanPack => {
    const p = `packs[${i}]`;
    const o = c.object(v, p, ['id', 'points', 'price']);
    return {
      id: c.id(o.id, `${p}.id`),
      points: c.perCurrency(o.points, `${p}.points`),
      price: c.price(o.price, `${p}.price`),
    };
  });
  c.unique(
    packs.map((k) => k.id),
    'packs',
  );

  const bump = c.object(top.checkout_bump, 'checkout_bump', [
    'points',
    'price',
  ]);
  const checkoutBump = {
    points: c.perCurrency(bump.points, 'checkout_bump.points'),
    price: c.price(bump.price, 'checkout_bump.price'),
  };

  const pts = c.object(top.points, 'points', [
    'price_per_1000_points',
    'bought_expiry_days',
  ]);
  const points = {
    pricePer1000Points: c.price(
      pts.price_per_1000_points,
      'points.price_per_1000_points',
    ),
    boughtExpiryDays: c.whole(
      pts.bought_expiry_days,
      'points.bought_expiry_days',
      1,
    ),
  };

  const cash = c.object(top.cash_out, 'cash_out', [
    'per_1000_points',
    'minimum_points',
  ]);
  const cashOut = {
    per1000Points: c.price(cash.per_1000_points, 'cash_out.per_1000_points'),
    minimumPoints: c.whole(cash.minimum_points, 'cash_out.minimum_points', 1),
  };

  const actionsO = c.object(top.action_points, 'action_points', PLAN_ACTIONS);
  const actions = PLAN_ACTIONS.map((id): PlanAction => {
    const p = `action_points.${id}`;
    const o = c.object(actionsO[id], p, ['points', 'per']);
    return {
      id,
      points: c.whole(o.points, `${p}.points`, 1),
      per: c.oneOf(o.per, `${p}.per`, ACTION_UNITS),
    };
  });

  const capsO = c.object(top.caps, 'caps', [
    'daily_points_per_user',
    'max_chars_per_job',
    'max_audio_min_per_job',
  ]);
  const caps = {
    dailyPointsPerUser: c.whole(
      capsO.daily_points_per_user,
      'caps.daily_points_per_user',
      1,
    ),
    maxCharsPerJob: c.whole(
      capsO.max_chars_per_job,
      'caps.max_chars_per_job',
      1,
    ),
    maxAudioMinPerJob: c.whole(
      capsO.max_audio_min_per_job,
      'caps.max_audio_min_per_job',
      1,
    ),
  };

  const ref = c.object(top.referral, 'referral', [
    'one_level_only',
    'referrer_must_be_verified',
    'hold_days',
    'base_points',
    'levels',
    'milestones',
  ]);
  const basePoints = c.map(ref.base_points, 'referral.base_points', (v, p) =>
    c.whole(v, p, 1),
  );
  for (const id of tierIds)
    if (!(id in basePoints))
      c.fail(`referral.base_points.${id}`, 'is missing (every tier needs one)');
  for (const id of Object.keys(basePoints))
    if (!tierIds.includes(id))
      c.fail(`referral.base_points.${id}`, 'names no tier');
  const levels = c.list(ref.levels, 'referral.levels').map((v, i) => {
    const p = `referral.levels[${i}]`;
    const o = c.object(v, p, ['min', 'x']);
    return {
      min: c.whole(o.min, `${p}.min`, 1),
      x: c.multiplier(o.x, `${p}.x`),
    };
  });
  levels.forEach((l, i) => {
    if (i === 0 && l.min !== 1)
      c.fail('referral.levels[0].min', 'must be 1 (the first level)');
    if (i > 0 && l.min <= levels[i - 1].min)
      c.fail(`referral.levels[${i}].min`, 'must be above the level before');
  });
  const milestones = c
    .list(ref.milestones, 'referral.milestones')
    .map((v, i) => {
      const p = `referral.milestones[${i}]`;
      const o = c.object(v, p, ['count', 'points']);
      return {
        count: c.whole(o.count, `${p}.count`, 1),
        points: c.whole(o.points, `${p}.points`, 1),
      };
    });
  milestones.forEach((m, i) => {
    if (i > 0 && m.count <= milestones[i - 1].count)
      c.fail(
        `referral.milestones[${i}].count`,
        'must be above the milestone before',
      );
  });
  const referral = {
    oneLevelOnly: c.bool(ref.one_level_only, 'referral.one_level_only'),
    referrerMustBeVerified: c.bool(
      ref.referrer_must_be_verified,
      'referral.referrer_must_be_verified',
    ),
    holdDays: c.whole(ref.hold_days, 'referral.hold_days', 0),
    basePoints,
    levels,
    milestones,
  };

  return {
    provisional,
    eventPasses,
    tiers,
    eventOffers,
    preselectedTier,
    tierEndingDays,
    extraProducts,
    packs,
    checkoutBump,
    points,
    cashOut,
    actions,
    caps,
    referral,
  };
}
