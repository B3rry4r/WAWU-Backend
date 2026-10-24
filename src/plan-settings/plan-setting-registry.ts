import { FX_CURRENCIES } from '../money/fx/fx-currencies';
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
  /**
   * Days a deleted account's ID documents may be kept (SETTINGS-09, R-73): a
   * year to ten years. The floor is there because the deletion cannot be undone:
   * a "5" typed for years must not empty the archive.
   */
  minIdDocsDays: 365,
  maxIdDocsDays: 3650,
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
/** A recording length in seconds: whole, from 1 to an hour. */
const seconds = whole(1, 3600);

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

/**
 * The languages Dubbing offers (AITOOLS-05): a list of lines, each a language
 * code, one space and the name a person reads ("yo Yoruba"). 1 to 200 lines,
 * each code once, no long dash in a name (R-5).
 */
function dubbingLanguages(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 200) {
    throw new SettingInvalid(
      'must be a list of 1 to 200 lines, each a language code, a space and the name',
    );
  }
  const seen = new Set<string>();
  return raw.map((line: unknown) => {
    const text = typeof line === 'string' ? line.trim() : '';
    const m = /^([a-z]{2,3}(?:-[A-Za-z]{2,4})?) (\S.{0,59})$/.exec(text);
    if (!m) {
      throw new SettingInvalid(
        'needs every line to be a language code, a space and the name (for example: yo Yoruba)',
      );
    }
    if (LONG_DASH.test(text)) {
      throw new SettingInvalid(
        'needs names without a long dash (write a comma or two sentences)',
      );
    }
    const code = m[1].toLowerCase();
    if (seen.has(code)) {
      throw new SettingInvalid(`lists the code ${m[1]} twice`);
    }
    seen.add(code);
    return text;
  });
}

/** One line of text: the `lines` rules with exactly one line (the event's name). */
function oneLine(raw: unknown): string[] {
  const one = lines(raw);
  if (one.length !== 1) throw new SettingInvalid('must be exactly one line');
  return one;
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
  add({
    key: 'plan.event_name',
    group: 'Event passes',
    label: 'Name of the event (one line)',
    unit: 'lines',
    usedBy: ['W44 (your pass)', 'W1 (the Passes card)', 'GET /me/tier'],
    provisional: BOARD,
    default: extra('plan.event_name', null),
    parse: oneLine,
    apply: (d, v) => {
      d.eventName = (v as string[])[0] ?? null;
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
  // Where each tool's cost is read: the job route that prices by it once the
  // tool is built on the pipeline (AITOOLS-02), or the task that builds it.
  const ACTION_ROUTES: Record<string, string> = {
    say_my_name: 'POST /me/voice/name-preview (VOICE-01)',
    voice_intro: 'POST /me/voice-intro/generate (VOICE-01)',
    voiceover_per_min: 'POST /ai-tools/voiceover/jobs (AITOOLS-01)',
    quick_voice_per_min: 'POST /ai-tools/quick-voice/jobs (AITOOLS-02)',
    captions_per_min: 'POST /ai-tools/captions/jobs (AITOOLS-04)',
    clean_audio_per_min: 'POST /ai-tools/clean-audio/jobs (AITOOLS-04)',
    music_per_track: 'POST /ai-tools/music/jobs (AITOOLS-03)',
    sfx: 'POST /ai-tools/sound-effect/jobs (AITOOLS-03)',
    dub_standard_per_min_lang: 'POST /ai-tools/dubbing/jobs (AITOOLS-05)',
    dub_premium_per_min_lang: 'the Dubbing job route (AITOOLS-05)',
    receptionist_message: 'the Receptionist route (AITOOLS-06)',
    receptionist_voice_per_min: 'the Receptionist route (AITOOLS-06)',
  };
  for (const a of plans.actions) {
    add({
      key: `points.action.${a.id}`,
      group: 'AI tool costs',
      label: `${a.id.replace(/_/g, ' ')} (points ${a.per.replace(/_/g, ' ')})`,
      unit: 'points',
      usedBy: [
        'PT1 (Studio)',
        'PT2 (the tool)',
        'GET /ai-tools',
        ACTION_ROUTES[a.id] ?? 'GET /plans',
      ],
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
    'cards.enabled',
    'The WAWU card: 1 is on, 0 is off (cards a person holds can still be frozen or blocked)',
    'count',
    ['GET /money/cards, POST /money/cards (R-84, WALLET-31)'],
    whole(0, 1),
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
    'ai.voiceover_chars_per_minute',
    'Characters of text that make one minute of VoiceOver',
    'count',
    ['PT2 (the minutes a script is priced in), POST /ai-tools/voiceover/jobs'],
    count,
    'AITOOLS-CHARS-PER-MINUTE',
  );
  other(
    'ai.quick_voice_chars_per_minute',
    'Characters of text that make one minute of Quick voice',
    'count',
    [
      'PT1 (Quick voice), GET /ai-tools (input.charactersPerUnit), POST /ai-tools/quick-voice/jobs',
    ],
    count,
    'AITOOLS-CHARS-PER-MINUTE',
  );
  // WALLET-25 and WALLET-26 (R-84, owner-asked controls): add money by card
  // and Apple Pay, and by USSD and the bank checkout, each on or off without
  // a deploy. 1 is on (the default), 0 is off: the route answers 409
  // add_money_unavailable and the app draws the rail as not available.
  for (const [key, label, usedBy] of [
    [
      'money.add_money_card_on',
      'Add money by card and Apple Pay (1 is on, 0 is off)',
      'GET /money/add-money/options, POST /money/add-money (W15, WALLET-25)',
    ],
    [
      'money.add_money_ussd_on',
      'Add money by USSD and the bank checkout (1 is on, 0 is off)',
      'GET /money/add-money/options, POST /money/add-money (W15, WALLET-26)',
    ],
  ] as const) {
    other(key, label, 'count', [usedBy], whole(0, 1));
  }
  // AITOOLS-03: the limits of the two prompt tools. The description's length
  // starts at the plan's own per-job character cap (not a new figure); the
  // longest sound and track are the provider's own maximums.
  for (const [key, label, usedBy] of [
    [
      'ai.sfx_max_prompt_chars',
      'Characters a Sound effect description can have',
      'GET /ai-tools (input.maxCharacters), POST /ai-tools/sound-effect/jobs',
    ],
    [
      'ai.music_max_prompt_chars',
      'Characters a Music track description can have',
      'GET /ai-tools (input.maxCharacters), POST /ai-tools/music/jobs',
    ],
  ] as const) {
    add({
      key,
      group: 'Other rulings',
      label,
      unit: 'count',
      usedBy: ['PT1 (the description box)', usedBy],
      provisional: 'AITOOLS-LIMITS',
      default: plans.caps.maxCharsPerJob,
      parse: count,
    });
  }
  add({
    key: 'ai.sfx_max_seconds',
    group: 'Other rulings',
    label: 'Longest Sound effect, in seconds',
    unit: 'count',
    usedBy: [
      'PT1 (the length), GET /ai-tools (input.length), POST /ai-tools/sound-effect/jobs',
    ],
    provisional: 'AITOOLS-LIMITS',
    default: extra('ai.sfx_max_seconds', 30),
    parse: whole(1, 30),
  });
  add({
    key: 'ai.music_max_seconds',
    group: 'Other rulings',
    label: 'Longest Music track, in seconds',
    unit: 'count',
    usedBy: [
      'PT1 (the length), GET /ai-tools (input.length), POST /ai-tools/music/jobs',
    ],
    provisional: 'AITOOLS-LIMITS',
    default: extra('ai.music_max_seconds', 300),
    parse: whole(3, 600),
  });
  // AITOOLS-04: the biggest file a person may send to Captions or Clean
  // audio. The provider's smallest documented limit (500 MB for the voice
  // isolator) is the default and the ceiling: an admin may only lower it.
  add({
    key: 'ai.input_max_bytes',
    group: 'Other rulings',
    label: 'Largest file for Captions or Clean audio, in bytes',
    unit: 'count',
    usedBy: [
      'POST /uploads/presign (folders ai/input-audio and ai/input-video)',
      'GET /ai-tools (input.maxBytes), POST /ai-tools/captions/jobs, POST /ai-tools/clean-audio/jobs',
    ],
    provisional: 'AITOOLS-LIMITS',
    default: extra('ai.input_max_bytes', 500 * 1024 * 1024),
    parse: whole(1_048_576, 512 * 1024 * 1024),
  });
  // AITOOLS-04 round 4: when the Hub believes the provider no longer keeps a
  // person's transcript. The provider answers a read 404 for about a second
  // after a delete and then shows the transcript again, so a transcript is
  // gone only after two reads that say 404, this far apart.
  add({
    key: 'ai.copy_confirm_after_minutes',
    group: 'Other rulings',
    label:
      'Minutes after a Captions job ends before a "not found" from the provider counts as the transcript being deleted',
    unit: 'count',
    usedBy: ['The provider copy sweep (Captions transcripts)'],
    provisional: 'AITOOLS-COPY-CONFIRM',
    default: extra('ai.copy_confirm_after_minutes', 10),
    parse: whole(1, 1440),
  });
  add({
    key: 'ai.copy_confirm_gap_minutes',
    group: 'Other rulings',
    label:
      'Minutes between the two "not found" reads that confirm a transcript is deleted at the provider',
    unit: 'count',
    usedBy: ['The provider copy sweep (Captions transcripts)'],
    provisional: 'AITOOLS-COPY-CONFIRM',
    default: extra('ai.copy_confirm_gap_minutes', 5),
    parse: whole(1, 1440),
  });
  // AITOOLS-05: Dubbing. The languages it offers are the provider's own list
  // (read from its help page on 24 Oct 2026); a dub that stays working longer
  // than its own limit is ended and its points given back (the provider states no
  // time, and no real run has been made).
  add({
    key: 'ai.dubbing_languages',
    group: 'Other rulings',
    label:
      'Languages Dubbing offers (one per line: the code, a space, the name)',
    unit: 'lines',
    usedBy: [
      'GET /ai-tools (input.file.dubbing.languages)',
      'POST /ai-tools/dubbing/jobs',
    ],
    provisional: 'AITOOLS-DUB-LANGUAGES',
    default: extra('ai.dubbing_languages', []),
    parse: dubbingLanguages,
  });
  add({
    key: 'ai.dubbing_max_run_minutes',
    group: 'Other rulings',
    label:
      'Minutes a dub can run before its held points are given back (its own limit, not the other tools)',
    unit: 'count',
    usedBy: [
      'The Dubbing follower (AITOOLS-05)',
      'The sweep of stale AI holds (POINTS-03)',
    ],
    provisional: 'AITOOLS-DUB-RUN',
    default: extra('ai.dubbing_max_run_minutes', 60),
    parse: whole(5, LIMIT.maxMinutes),
  });
  add({
    key: 'capital.enabled',
    group: 'Other rulings',
    label:
      'Capital: 1 takes new orders, 0 closes them (what a person holds can still be read and withdrawn)',
    unit: 'count',
    usedBy: [
      'GET /capital/availability, the Wallet tab row (NUV-12)',
      'Every /capital route (NUV-12)',
    ],
    provisional: 'CAPITAL-ENABLED',
    default: extra('capital.enabled', 1),
    parse: whole(0, 1),
  });
  other(
    'voice.intro_max_chars',
    'Characters a Voice Intro script can have',
    'count',
    ['VF8 (the Voice Intro words), PUT /me/voice-intro/text'],
    count,
    'VOICE-INTRO-MAX-CHARS',
  );
  other(
    'voice_intro.sample_min_seconds',
    'Shortest Voice Intro recording the app takes, in seconds',
    'count',
    ['VF9, VF9b (the take is refused below it), GET /me/voice-intro'],
    seconds,
    'VOICE-SAMPLE-SECONDS',
  );
  other(
    'voice_intro.sample_max_seconds',
    'Longest Voice Intro recording the app takes, in seconds',
    'count',
    ['VF9 (the ring and the timer), GET /me/voice-intro'],
    seconds,
    'VOICE-SAMPLE-SECONDS',
  );
  other(
    'voice.name_previews_per_hour',
    'Free "hear your name" previews one person can ask for in an hour',
    'count',
    ['VF3, POST /me/voice/name-preview'],
    count,
    'VOICE-NAME-PREVIEWS',
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
    'id_docs_keep_days',
    'Days the ID documents of a deleted account are kept, hidden, before they are deleted',
    'days',
    ['the daily ID document sweep (SETTINGS-09, R-73)'],
    whole(LIMIT.minIdDocsDays, LIMIT.maxIdDocsDays),
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
  for (const n of [1, 2, 3, 4]) {
    other(
      `content.price_preset_${n}_kobo`,
      `Quick price ${n} on the create flow's price step`,
      'kobo',
      ['M24 (the quick prices), GET /content/sale-terms (FIX-110)'],
      kobo,
      BOARD,
    );
  }
  other(
    'content.review_hours',
    'Hours a review of a new piece usually takes',
    'hours',
    ['M25 (Usually takes), GET /content/sale-terms (FIX-110)'],
    hours,
    'CONTENT-REVIEW-HOURS',
  );

  // ---- Foreign accounts, swaps and crypto sends (WALLET-21, R-83, R-84) ----
  // One switch per currency and one per product: 1 is on, 0 is off. On by
  // default (the dev launch); an admin turns one off without a deploy. Read
  // live by GET /money/fx/currencies and by every foreign-account route.
  const onOff = whole(0, 1);
  for (const c of FX_CURRENCIES) {
    other(
      `fx.currency.${c.code}.on`,
      `${c.name} (${c.code}) accounts, swaps and sends: 1 is on, 0 is off`,
      'count',
      ['GET /money/fx/currencies', 'POST /money/fx/accounts (WALLET-21, R-84)'],
      onOff,
    );
  }
  other(
    'fx.product.open_account.on',
    'Opening a foreign or stablecoin account: 1 is on, 0 is off',
    'count',
    ['POST /money/fx/accounts (WALLET-21, R-84)'],
    onOff,
  );
  other(
    'fx.product.swap.on',
    'Swapping between currencies: 1 is on, 0 is off',
    'count',
    ['POST /money/fx/quotes, POST /money/fx/swaps (WALLET-21, R-84)'],
    onOff,
  );
  other(
    'fx.product.crypto_send.on',
    'Sending USDT, USDC or RLUSD to an outside address: 1 is on, 0 is off',
    'count',
    ['POST /money/fx/sends (WALLET-21, R-84)'],
    onOff,
  );

  // ---- A wallet for a person outside Nigeria (WALLET-41, R-87) ----
  other(
    'world.open.on',
    'Opening a wallet without a BVN for a person outside Nigeria: 1 is on, 0 is off',
    'count',
    ['GET /money/world/options', 'POST /money/wallet/open (WALLET-41, R-87)'],
    onOff,
  );

  return out;
}
