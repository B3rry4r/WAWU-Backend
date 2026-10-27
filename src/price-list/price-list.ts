/**
 * THE PRICE LIST (PRICE-LIST, R-101).
 *
 * Every price a person sets is picked from a list the owner keeps in admin
 * settings: `prices.list_naira` for a piece, a paid question, a community pass
 * and an event ticket, and `prices.tip_list_naira` for a tip. Both are lists of
 * whole naira. They are stored as lines of digits (the settings screen's
 * "lines" input), and read here as numbers.
 *
 * Pure: no database, no settings service. The service that reads the live
 * lists is `PriceListService`.
 */

/** The setting that holds the price list, in whole naira. */
export const PRICE_LIST_KEY = 'prices.list_naira';

/** The setting that holds the tip list, in whole naira. Every tip is also on the price list. */
export const TIP_LIST_KEY = 'prices.tip_list_naira';

/** The most a price may be, in whole naira. R-101: the list tops out at ₦1,000,000. */
export const PRICE_MAX_NAIRA = 1_000_000;

/** The most prices a list may hold. A checking limit, not a product figure. */
export const PRICE_LIST_MAX_ENTRIES = 200;

/** The refusal code every route answers with when a price is not on the list. */
export const PRICE_NOT_ON_LIST_CODE = 'price_not_on_list' as const;

/** Why a list is refused, in words that complete "<key> ...". Thrown as plain text; the registry wraps it. */
export class PriceListProblem extends Error {}

/**
 * Checks a list an admin sends and returns the lines to store. Each entry is a
 * whole naira number, or text that is only digits. Strictly ascending, each
 * once, each above 0 and at most ₦1,000,000.
 */
export function parseNairaLines(raw: unknown): string[] {
  if (
    !Array.isArray(raw) ||
    raw.length < 1 ||
    raw.length > PRICE_LIST_MAX_ENTRIES
  ) {
    throw new PriceListProblem(
      `must be a list of 1 to ${PRICE_LIST_MAX_ENTRIES} prices, each a whole number of naira`,
    );
  }
  let before = 0;
  return raw.map((item: unknown) => {
    const n =
      typeof item === 'number'
        ? item
        : typeof item === 'string' && /^[0-9]{1,9}$/.test(item.trim())
          ? Number(item.trim())
          : NaN;
    if (!Number.isSafeInteger(n)) {
      throw new PriceListProblem(
        'needs every price to be a whole number of naira, written in digits only',
      );
    }
    if (n < 1 || n > PRICE_MAX_NAIRA) {
      throw new PriceListProblem(
        `needs every price to be above 0 and at most ${PRICE_MAX_NAIRA}`,
      );
    }
    if (n === before) {
      throw new PriceListProblem(`lists ${n} more than once`);
    }
    if (n < before) {
      throw new PriceListProblem(
        'needs the prices from the lowest to the highest',
      );
    }
    before = n;
    return String(n);
  });
}

/** The lines of a stored list as numbers. */
export function nairaNumbers(lines: readonly string[]): number[] {
  return lines.map((l) => Number(l));
}

/** The names of the prices in `tips` that are not on `prices`, lowest first. Empty when the tip list is a subset. */
export function tipsOffTheList(
  prices: readonly number[],
  tips: readonly number[],
): number[] {
  const on = new Set(prices);
  return tips.filter((t) => !on.has(t));
}

/** The list prices either side of a price: the highest at or below it, the lowest at or above it. */
export function neighbours(
  list: readonly number[],
  price: number,
): { lower: number | null; higher: number | null } {
  let lower: number | null = null;
  let higher: number | null = null;
  for (const p of list) {
    if (p <= price) lower = p;
    if (p >= price) {
      higher = p;
      break;
    }
  }
  return { lower, higher };
}

/**
 * The list price nearest to `price`. On a tie the lower one. A price above the
 * top moves to the top; a price below the bottom moves to the bottom. The list
 * must not be empty.
 */
export function nearestOnList(list: readonly number[], price: number): number {
  const { lower, higher } = neighbours(list, price);
  if (lower === null) return higher as number;
  if (higher === null) return lower;
  return price - lower <= higher - price ? lower : higher;
}
