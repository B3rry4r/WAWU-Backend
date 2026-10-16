/**
 * What a creator may choose on the paid messages settings (task INBOX-12, I21).
 *
 * The price bounds are the ones the live `PATCH /creator/dm-settings` already
 * enforces (50 to 10,000,000 naira), stated here in kobo because every new
 * money route is kobo. The preset prices and the reply windows are the
 * design's and the web's (100, 500, 1,000 and 2,500 naira; 24 hours, 2, 3 and
 * 7 days). They are read from the environment so the owner can change a list
 * without a deploy of code, and the app draws whatever this serves.
 *
 * PROVISIONAL(PAID-DM-SETTINGS-OPTIONS, owner=YOU, why=no ruling names the preset prices or the reply windows; they are the design's and the web's until the owner rules)
 */
export interface PaidDmSettingsConfig {
  /** Lowest price a paid message may have, in kobo. */
  minPriceKobo: number;
  /** Highest price a paid message may have, in kobo. */
  maxPriceKobo: number;
  /** The quick prices the screen offers, in kobo, ascending. */
  pricePresetsKobo: number[];
  /** The reply windows the screen offers, in hours, ascending. */
  responseWindowHours: number[];
}

/** The same bounds `UpdateDmSettingsDto` holds, in whole naira. */
export const DM_PRICE_MIN_NAIRA = 50;
export const DM_PRICE_MAX_NAIRA = 10_000_000;
/** The window bounds `UpdateDmSettingsDto` holds, in hours. */
export const DM_RESPONSE_HOURS_MIN = 1;
export const DM_RESPONSE_HOURS_MAX = 336;

const KOBO = 100;
const DEFAULT_PRESETS_NAIRA = [100, 500, 1000, 2500];
const DEFAULT_WINDOWS_HOURS = [24, 48, 72, 168];

/**
 * A comma list of whole numbers inside the bounds, ascending and without
 * repeats. Anything else (empty, a word, out of range) falls back to the
 * default list rather than serving a list that could not be saved.
 */
function list(
  name: string,
  fallback: number[],
  min: number,
  max: number,
): number[] {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parts = raw.split(',').map((p) => p.trim());
  const nums = parts.map(Number);
  const ok =
    parts.length > 0 &&
    parts.every((p) => p !== '') &&
    nums.every((n) => Number.isInteger(n) && n >= min && n <= max);
  if (!ok) return fallback;
  return [...new Set(nums)].sort((a, b) => a - b);
}

/** Read on every call, so a test (or an operator) can change it without a rebuild. */
export function paidDmSettingsConfig(): PaidDmSettingsConfig {
  return {
    minPriceKobo: DM_PRICE_MIN_NAIRA * KOBO,
    maxPriceKobo: DM_PRICE_MAX_NAIRA * KOBO,
    pricePresetsKobo: list(
      'PAID_DM_PRICE_PRESETS_NAIRA',
      DEFAULT_PRESETS_NAIRA,
      DM_PRICE_MIN_NAIRA,
      DM_PRICE_MAX_NAIRA,
    ).map((n) => n * KOBO),
    responseWindowHours: list(
      'PAID_DM_RESPONSE_WINDOWS_HOURS',
      DEFAULT_WINDOWS_HOURS,
      DM_RESPONSE_HOURS_MIN,
      DM_RESPONSE_HOURS_MAX,
    ),
  };
}
