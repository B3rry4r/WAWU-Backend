import { INT4_MAX, type PlansConfig } from '../plans/plans-config';
import {
  SettingInvalid,
  type Draft,
  type ExtrasDefaults,
  type MilestoneStep,
  type MultiplierLevel,
  type SettingDef,
  type SettingValue,
} from './plan-setting-types';

/**
 * THE REGISTRY OF ADMIN SETTINGS (TIER-06, R-65).
 *
 * Every launch figure an admin can change without a deploy is one entry here:
 * its key, the screens that print it, how a value is checked, and where it
 * goes in the live plan. The defaults are not written here: they are read from
 * the seed (`plans.config.json` for the plan's own figures,
 * `plan-settings.defaults.json` for the rest), so no figure appears in code
 * (R-43). The keys of the tiers, packs, actions and passes follow the ids in
 * the seed, so a tier added to the file gets its settings with no code change.
 *
 * 85/15 is not a setting. It is the one split on every stream (R-5).
 *
 * A bad value is refused with a reason in plain words and nothing is stored.
 * Zero and negative numbers are refused wherever a zero would break the
 * product (a price, a rate, a count); a percent may be 0.
 */

/** The marker the board's figures carry (R-65: "any other figure drawn on a board"). */
const BOARD = 'DV2-BOARD-FIGURE';

/** Checking limits (what an admin can type), not product figures. */
const LIMIT = {
  /** Most lines under a pass. */
  lines: 8,
  /** Longest line under a pass. */
  lineLength: 120,
  /** Most steps in a referral ladder. */
  steps: 12,
  /** Highest referral multiplier. */
  maxMultiplier: 10,
  /** A year of hours. */
  maxHours: 8760,
  /** A week of minutes (the longest an AI job may run before its points are given back). */
  maxMinutes: 10_080,
  /** Three years of days. */
  maxDays: 1095,
  /** Ten years of months. */
  maxMonths: 120,
  /** One hundred percent. */
  percent: 100,
  /** Most people in any count of members. */
  maxPeople: 1_000_000,
  /** Most bank name checks one person may make in an hour (WALLET-37's limit on the old key). */
  maxNameChecks: 1000,
} as const;

const DAYS_PER_YEAR = 365;
const MONTHS_PER_YEAR = 12;

/** Whole days that `months` months last (a year is 365 days). */
export function daysInMonths(months: number): number {
  return Math.round((months * DAYS_PER_YEAR) / MONTHS_PER_YEAR);
}

function whole(min: number, max: number) {
  return (raw: unknown): number => {
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) {
      throw new SettingInvalid(`must be a whole number from ${min} to ${max}`);
    }
    if (raw < min || raw > max) {
      throw new SettingInvalid(
        raw < min ? `must be ${min} or more` : `must be ${max} or less`,
      );
    }
    return raw;
  };
}

/** A price or a rate in kobo: whole, 1 or more. A zero is refused. */
const kobo = whole(1, INT4_MAX);
const count = whole(1, INT4_MAX);
const points = whole(1, INT4_MAX);
const percent = whole(0, LIMIT.percent);
const days = whole(1, LIMIT.maxDays);
const months = whole(1, LIMIT.maxMonths);
const hours = whole(1, LIMIT.maxHours);
const minutes = whole(1, LIMIT.maxMinutes);
const people = whole(1, LIMIT.maxPeople);

/** An en dash or an em dash, written by code so no source line carries one (R-5). */
export const LONG_DASH = new RegExp(
  `[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`,
);

function lines(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length > LIMIT.lines) {
    throw new SettingInvalid(
      `must be a list of at most ${LIMIT.lines} lines of text`,
    );
  }
  return raw.map((line: unknown) => {
    if (typeof line !== 'string') {
      throw new SettingInvalid('must be a list of lines of text');
    }
    const text = line.trim();
    if (text === '' || text.length > LIMIT.lineLength) {
      throw new SettingInvalid(
        `needs every line to be 1 to ${LIMIT.lineLength} characters`,
      );
    }
    // R-5: nothing a person reads carries a long dash.
    if (LONG_DASH.test(text)) {
      throw new SettingInvalid(
        'needs lines without a long dash (write a comma or two sentences)',
      );
    }
    return text;
  });
}

function date(raw: unknown): string {
  const ok =
    typeof raw === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(raw) &&
    new Date(`${raw}T00:00:00.000Z`).toISOString().slice(0, 10) === raw;
  if (!ok) throw new SettingInvalid('must be a real date written YYYY-MM-DD');
  return raw;
}

function time(raw: unknown): string {
  if (typeof raw !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(raw)) {
    throw new SettingInvalid('must be a time of day written HH:MM (24 hours)');
  }
  return raw;
}

function objectWith(
  raw: unknown,
  keys: readonly string[],
  what: string,
): Record<string, unknown> {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    Array.isArray(raw) ||
    Object.keys(raw).sort().join() !== [...keys].sort().join()
  ) {
    throw new SettingInvalid(
      `needs every ${what} written as { ${keys.join(', ')} }`,
    );
  }
  return raw as Record<string, unknown>;
}

function levels(raw: unknown): MultiplierLevel[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > LIMIT.steps) {
    throw new SettingInvalid(`must be a list of 1 to ${LIMIT.steps} levels`);
  }
  let before: MultiplierLevel | null = null;
  return raw.map((item: unknown, i) => {
    const o = objectWith(item, ['min', 'x'], 'level');
    const min = whole(1, INT4_MAX)(o.min);
    const x = o.x;
    if (
      typeof x !== 'number' ||
      !Number.isFinite(x) ||
      x < 1 ||
      x > LIMIT.maxMultiplier ||
      Math.abs(x * 100 - Math.round(x * 100)) > 1e-9
    ) {
      throw new SettingInvalid(
        `needs a multiplier from 1 to ${LIMIT.maxMultiplier} with at most 2 decimals`,
      );
    }
    if (i === 0 && min !== 1) {
      throw new SettingInvalid('needs the first level to start at 1 referral');
    }
    if (before && (min <= before.min || x < before.x)) {
      throw new SettingInvalid(
        'needs each level to start higher and pay at least as much as the one before',
      );
    }
    before = { min, x };
    return { min, x };
  });
}

function milestones(raw: unknown): MilestoneStep[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > LIMIT.steps) {
    throw new SettingInvalid(
      `must be a list of 1 to ${LIMIT.steps} milestones`,
    );
  }
  let before = 0;
  return raw.map((item: unknown) => {
    const o = objectWith(item, ['count', 'points'], 'milestone');
    const c = whole(1, INT4_MAX)(o.count);
    const p = whole(1, INT4_MAX)(o.points);
    if (c <= before) {
      throw new SettingInvalid(
        'needs each milestone to start higher than the one before',
      );
    }
    before = c;
    return { count: c, points: p };
  });
}

/** What the registry builds a setting from. */
interface Spec {
  key: string;
  group: string;
  label: string;
  unit: SettingDef['unit'];
  usedBy: readonly string[];
  provisional?: string | null;
  default: SettingValue;
  parse: (raw: unknown) => SettingValue;
  apply?: SettingDef['apply'];
}

function def(s: Spec): SettingDef {
  return { ...s, provisional: s.provisional ?? null };
}

const TIER_USED = {
  price_kobo: [
    'VF5 (tier cards)',
    'VF5b (the difference)',
    'VF6 (checkout)',
    'VF14 (your tier)',
    'E21 (From, the lowest)',
    'GET /plans',
    'GET /plans/purchases/quote',
  ],
  days: ['VF5', 'VF6', 'VF14', 'GET /plans', 'the tier grant'],
  products: [
    'VF5',
    'VF6',
    'VF12',
    'VF13',
    'VF14',
    'GET /plans',
    'the publishing allowance',
  ],
  bonus_points: ['VF1', 'VF5', 'VF7', 'GET /plans', 'the tier grant'],
  pack_bonus_pct: [
    'PT4 (the Founding bonus)',
    'POST /plans/purchases (points_pack)',
    'GET /plans',
  ],
} as const;

/**
 * Builds every setting from the seed. Called once at boot and checked whole:
 * a seed value that its own check refuses stops the server naming the key.
 */
export function buildRegistry(
  plans: PlansConfig,
  extras: ExtrasDefaults,
): SettingDef[] {
  const out: SettingDef[] = [];
  const add = (s: Spec) => out.push(def(s));
  const extra = (key: string, fallback: SettingValue): SettingValue =>
    key in extras.values ? (extras.values[key] as SettingValue) : fallback;

  // ---- Tiers (VF5, VF6, VF14, E21) ---------------------------------------
  for (const t of plans.tiers) {
    const at = (draft: Draft<PlansConfig>) =>
      draft.tiers.find((x) => x.id === t.id)!;
    const group = `Tier: ${t.name}`;
    add({
      key: `plan.tier.${t.id}.price_kobo`,
      group,
      label: `${t.name}: price`,
      unit: 'kobo',
      usedBy: TIER_USED.price_kobo,
      default: t.price.kobo,
      parse: kobo,
      apply: (d, v) => {
        at(d).price.kobo = v as number;
      },
    });
    add({
      key: `plan.tier.${t.id}.days`,
      group,
      label: `${t.name}: how long it lasts`,
      unit: 'days',
      usedBy: TIER_USED.days,
      provisional: BOARD,
      default: t.days,
      parse: days,
      apply: (d, v) => {
        at(d).days = v as number;
      },
    });
    add({
      key: `plan.tier.${t.id}.products`,
      group,
      label: `${t.name}: products it allows`,
      unit: 'count',
      usedBy: TIER_USED.products,
      provisional: BOARD,
      default: t.products,
      parse: count,
      apply: (d, v) => {
        at(d).products = v as number;
      },
    });
    add({
      key: `plan.tier.${t.id}.bonus_points`,
      group,
      label: `${t.name}: bonus points`,
      unit: 'points',
      usedBy: TIER_USED.bonus_points,
      provisional: BOARD,
      default: t.bonusPoints,
      parse: points,
      apply: (d, v) => {
        at(d).bonusPoints = v as number;
      },
    });
    add({
      key: `plan.tier.${t.id}.pack_bonus_pct`,
      group,
      label: `${t.name}: extra points on packs`,
      unit: 'percent',
      usedBy: TIER_USED.pack_bonus_pct,
      provisional: BOARD,
      default: t.packBonusPct,
      parse: percent,
      apply: (d, v) => {
        at(d).packBonusPct = v as number;
      },
    });
  }

  // ---- Add more products (VF13, TIER-04) ---------------------------------
  add({
    key: 'plan.extra_products.price_kobo',
    group: 'Add more products',
    label: 'Price of one add-on',
    unit: 'kobo',
    usedBy: ['VF13', 'POST /plans/purchases (extra_products)', 'GET /plans'],
    default: plans.extraProducts.price.kobo,
    parse: kobo,
    apply: (d, v) => {
      d.extraProducts.price.kobo = v as number;
    },
  });
  add({
    key: 'plan.extra_products.count',
    group: 'Add more products',
    label: 'Products in one add-on',
    unit: 'count',
    usedBy: ['VF13', 'POST /plans/purchases (extra_products)', 'GET /plans'],
    default: plans.extraProducts.count,
    parse: count,
    apply: (d, v) => {
      d.extraProducts.count = v as number;
    },
  });

  // ---- Points packs (PT4, POINTS-02) -------------------------------------
  for (const p of plans.packs) {
    const at = (draft: Draft<PlansConfig>) =>
      draft.packs.find((x) => x.id === p.id)!;
    add({
      key: `plan.pack.${p.id}.points`,
      group: 'Points packs',
      label: `Pack ${p.id.toUpperCase()}: points`,
      unit: 'points',
      usedBy: ['PT4', 'POINTS-02', 'GET /plans'],
      provisional: BOARD,
      default: p.points.NGN,
      parse: points,
      apply: (d, v) => {
        at(d).points.NGN = v as number;
      },
    });
    add({
      key: `plan.pack.${p.id}.price_kobo`,
      group: 'Points packs',
      label: `Pack ${p.id.toUpperCase()}: price`,
      unit: 'kobo',
      usedBy: ['PT4', 'POINTS-02', 'GET /plans'],
      provisional: BOARD,
      default: p.price.kobo,
      parse: kobo,
      apply: (d, v) => {
        at(d).price.kobo = v as number;
      },
    });
  }
  add({
    key: 'plan.checkout_bump.points',
    group: 'Points packs',
    label: 'Checkout offer: points',
    unit: 'points',
    usedBy: ['VF6 (the add-on offer)', 'GET /plans'],
    provisional: BOARD,
    default: plans.checkoutBump.points.NGN,
    parse: points,
    apply: (d, v) => {
      d.checkoutBump.points.NGN = v as number;
    },
  });
  add({
    key: 'plan.checkout_bump.price_kobo',
    group: 'Points packs',
    label: 'Checkout offer: price',
    unit: 'kobo',
    usedBy: ['VF6 (the add-on offer)', 'GET /plans'],
    provisional: BOARD,
    default: plans.checkoutBump.price.kobo,
    parse: kobo,
    apply: (d, v) => {
      d.checkoutBump.price.kobo = v as number;
    },
  });

  // ---- Tier ending, passes and the event (VF14, W44) ---------------------
  add({
    key: 'plan.tier_ending_days',
    group: 'Event passes',
    label: 'Days before the end a tier counts as ending',
    unit: 'days',
    usedBy: ['VF14', 'GET /me/tier'],
    provisional: 'PLAN-ENDING-DAYS',
    default: plans.tierEndingDays,
    parse: days,
    apply: (d, v) => {
      d.tierEndingDays = v as number;
    },
  });
  for (const p of plans.eventPasses) {
    add({
      key: `plan.event_pass.${p.id}.benefits`,
      group: 'Event passes',
      label: `${p.name}: the lines under the pass`,
      unit: 'lines',
      usedBy: ['W44 (your pass)', 'GET /me/tier', 'GET /plans'],
      provisional: 'W44-PASS-LINES',
      default: extra(`plan.event_pass.${p.id}.benefits`, null),
      parse: lines,
      apply: (d, v) => {
        d.eventPasses.find((x) => x.id === p.id)!.benefits = v as string[];
      },
    });
  }
  add({
    key: 'plan.event_date',
    group: 'Event passes',
    label: 'Day of the event',
    unit: 'date',
    usedBy: ['W44 (your pass)', 'GET /me/tier', 'GET /plans'],
    default: extra('plan.event_date', null),
    parse: date,
    apply: (d, v) => {
      d.eventDate = v as string;
    },
  });

  // ---- Points (PT1 to PT7) -----------------------------------------------
  add({
    key: 'points.cash_rate_kobo_per_1000',
    group: 'Points',
    label: 'Cash paid into the wallet for each thousand points',
    unit: 'kobo',
    usedBy: ['PT6', 'PT6a', 'W1 (To cash)', 'GET /points/convert/quote'],
    default: plans.cashOut.per1000Points.kobo,
    parse: kobo,
    apply: (d, v) => {
      d.cashOut.per1000Points.kobo = v as number;
    },
  });
  add({
    key: 'points.cash_out_minimum_points',
    group: 'Points',
    label: 'Fewest points that can be converted at once',
    unit: 'points',
    usedBy: ['PT6', 'GET /points/convert/quote'],
    provisional: 'PLAN-CASHOUT-MINIMUM',
    default: plans.cashOut.minimumPoints,
    parse: points,
    apply: (d, v) => {
      d.cashOut.minimumPoints = v as number;
    },
  });
  add({
    key: 'points.price_kobo_per_1000',
    group: 'Points',
    label:
      'Price of each thousand points when a shortfall is paid from the wallet',
    unit: 'kobo',
    usedBy: ['PT3', 'PT4', 'GET /plans'],
    provisional: 'PLAN-PRICES',
    default: plans.points.pricePer1000Points.kobo,
    parse: kobo,
    apply: (d, v) => {
      d.points.pricePer1000Points.kobo = v as number;
    },
  });
  add({
    key: 'points.expiry_months',
    group: 'Points',
    label: 'How long every lot of points lasts',
    unit: 'months',
    usedBy: [
      'PT4',
      'PT5 (lots)',
      'VF1',
      'VF7',
      'the tier grant (bonus lots)',
      'POINTS-02 (bought lots)',
      'REF-02 (referral lots)',
    ],
    default: extra('points.expiry_months', null),
    parse: months,
    apply: (d, v) => {
      const lasts = daysInMonths(v as number);
      for (const t of d.tiers) t.bonusExpiryDays = lasts;
      d.points.boughtExpiryDays = lasts;
    },
  });
  add({
    key: 'points.daily_cap',
    group: 'Points',
    label: 'Points one person can spend on AI tools in a day',
    unit: 'points',
    usedBy: ['PT7', 'points_cap_reached (POINTS-03)', 'GET /plans'],
    default: plans.caps.dailyPointsPerUser,
    parse: points,
    apply: (d, v) => {
      d.caps.dailyPointsPerUser = v as number;
    },
  });
  add({
    key: 'points.max_chars_per_job',
    group: 'Points',
    label: 'Characters one AI job can take',
    unit: 'count',
    usedBy: ['PT7', 'points_cap_reached (POINTS-03)', 'GET /plans'],
    default: plans.caps.maxCharsPerJob,
    parse: count,
    apply: (d, v) => {
      d.caps.maxCharsPerJob = v as number;
    },
  });
  add({
    key: 'points.max_audio_min_per_job',
    group: 'Points',
    label: 'Minutes of audio one AI job can run',
    unit: 'count',
    usedBy: ['PT7', 'points_cap_reached (POINTS-03)', 'GET /plans'],
    default: plans.caps.maxAudioMinPerJob,
    parse: count,
    apply: (d, v) => {
      d.caps.maxAudioMinPerJob = v as number;
    },
  });
  for (const a of plans.actions) {
    add({
      key: `points.action.${a.id}`,
      group: 'AI tool costs',
      label: `${a.id.replace(/_/g, ' ')} (points ${a.per.replace(/_/g, ' ')})`,
      unit: 'points',
      usedBy: ['PT1 (Studio)', 'PT2 (the tool)', 'GET /plans'],
      provisional: BOARD,
      default: a.points,
      parse: points,
      apply: (d, v) => {
        d.actions.find((x) => x.id === a.id)!.points = v as number;
      },
    });
  }

  // ---- Referral (RF1 to RF4, REF-02) -------------------------------------
  add({
    key: 'referral.multipliers',
    group: 'Referral',
    label: 'Multiplier by verified referrals',
    unit: 'levels',
    usedBy: ['RF1', 'RF3', 'RF3a', 'RF4', 'REF-02'],
    default: plans.referral.levels.map((l) => ({ min: l.min, x: l.x })),
    parse: levels,
    apply: (d, v) => {
      d.referral.levels = (v as MultiplierLevel[]).map((l) => ({ ...l }));
    },
  });
  add({
    key: 'referral.milestones',
    group: 'Referral',
    label: 'Milestone points by verified referrals',
    unit: 'milestones',
    usedBy: ['RF1', 'RF3a', 'REF-02'],
    provisional: BOARD,
    default: plans.referral.milestones.map((m) => ({
      count: m.count,
      points: m.points,
    })),
    parse: milestones,
    apply: (d, v) => {
      d.referral.milestones = (v as MilestoneStep[]).map((m) => ({ ...m }));
    },
  });
  add({
    key: 'referral.hold_days',
    group: 'Referral',
    label: 'Days a reward is held',
    unit: 'days',
    usedBy: ['RF1', 'RF3', 'RF4', 'REF-02'],
    default: plans.referral.holdDays,
    parse: days,
    apply: (d, v) => {
      d.referral.holdDays = v as number;
    },
  });
  add({
    key: 'referral.claim_days',
    group: 'Referral',
    label: 'Days after sign-up in which a code can be claimed',
    unit: 'days',
    usedBy: ['RF3a', 'POST /me/referrals/claim (REF-02)'],
    provisional: 'REF-CLAIM-DAYS',
    default: extra('referral.claim_days', null),
    parse: days,
  });
  for (const tierId of Object.keys(plans.referral.basePoints)) {
    add({
      key: `referral.base_points.${tierId}`,
      group: 'Referral',
      label: `Base points when a referral buys ${
        plans.tiers.find((t) => t.id === tierId)?.name ?? tierId
      }`,
      unit: 'points',
      usedBy: ['RF1', 'RF3', 'REF-02'],
      provisional: BOARD,
      default: plans.referral.basePoints[tierId],
      parse: points,
      apply: (d, v) => {
        d.referral.basePoints[tierId] = v as number;
      },
    });
  }

  // ---- Figures from the other 16 Oct rulings -----------------------------
  const other = (
    key: string,
    label: string,
    unit: SettingDef['unit'],
    usedBy: readonly string[],
    parse: (raw: unknown) => SettingValue,
    provisional?: string,
  ) =>
    add({
      key,
      group: 'Other rulings',
      label,
      unit,
      usedBy,
      provisional,
      default: extra(key, null),
      parse,
    });
  other(
    'name_check_per_hour',
    'Account name checks one person can make in an hour',
    'count',
    ['POST /money/banks/name-check (R-51, WALLET-37)'],
    whole(1, LIMIT.maxNameChecks),
  );
  other(
    'popular_community_min_members',
    'Members a community needs to be called popular',
    'count',
    ['GET /search/popular (R-57, EXPLORE-06)'],
    people,
  );
  other(
    'community_credit_cost_photo',
    'Credits to send a photo in a community',
    'count',
    ['I24 to I28, I38 (R-62, INBOX-22)'],
    count,
  );
  other(
    'community_credit_cost_video',
    'Credits to send a video in a community',
    'count',
    ['I24 to I28, I38 (R-62, INBOX-22)'],
    count,
  );
  other(
    'community_credit_cost_voice',
    'Credits to send a voice note in a community',
    'count',
    ['I24 to I28, I38 (R-62, INBOX-22)'],
    count,
  );
  other(
    'points.job_max_run_minutes',
    'Minutes an AI job can run before its held points are given back',
    'count',
    ['The sweep of stale AI holds (POINTS-03)'],
    minutes,
    'POINTS-JOB-MAX-RUN',
  );
  other(
    'tgif_notification_time',
    'Morning time of the TGIF notification (Africa/Lagos)',
    'time',
    ['HOME-16 (R-59, owner answer 32)'],
    time,
  );
  other(
    'tgif_notice_retention_days',
    'Days a daily TGIF notice is kept before it is cleared',
    'days',
    ['the daily TGIF notice clean-up (HOME-17)'],
    days,
  );
  other(
    'earnings.daily_move_floor_kobo',
    'Smallest day total a creator earnings move will send',
    'kobo',
    ['WALLET-16 (R-55)'],
    kobo,
  );
  other(
    'plan.transfer_window_hours',
    'Hours a bank-transfer purchase waits for the money before it lapses',
    'hours',
    ['POST /plans/purchases method transfer (TIER-05, VF6)'],
    hours,
    'PLAN-TRANSFER-WINDOW',
  );
  other(
    'events.open_orders_per_buyer',
    'Most open ticket orders per buyer per event',
    'count',
    [
      'POST /events/{id}/orders/wallet (EVENTS-13)',
      'POST /events/orders/wallet/pay (EVENTS-13)',
    ],
    count,
    'EVENT-ORDER-CAP',
  );
  other(
    'earnings.refused_review_hours',
    'Hours after the first refusal before a refused earning goes to review',
    'hours',
    ['WALLET-16 (R-55)'],
    hours,
  );

  return out;
}
