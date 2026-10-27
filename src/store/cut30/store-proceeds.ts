/**
 * What WAWU earns from a store purchase, and how it is counted against the
 * store's yearly threshold (STORE-CUT30, R-101 point 9). Pure.
 */

/** The Africa/Lagos calendar year of an instant (Lagos is UTC+1 all year). */
export function lagosYear(at: Date): number {
  return new Date(at.getTime() + 3_600_000).getUTCFullYear();
}

/** The first instant of a Lagos calendar year. */
export function lagosYearStart(year: number): Date {
  return new Date(`${String(year).padStart(4, '0')}-01-01T00:00:00+01:00`);
}

export interface ProceedsFacts {
  netKobo: number | null;
  currency: string | null;
  priceMicros: bigint | null;
  storeFeeBps: number;
}

/**
 * What the store pays WAWU for one purchase, in kobo, or null when the Hub
 * cannot say. A ladder sale and anything with a reference price carry
 * `netKobo` (for a ladder sale it is the list price: the store price is made
 * so WAWU receives at least that). Otherwise, a sale the store charged in
 * naira is its price less the store's cut. A sale in another currency with no
 * reference is not counted (nothing here can convert it); it is rare, since the
 * products that sell for money all carry a reference price.
 */
export function proceedsKoboOf(f: ProceedsFacts): bigint | null {
  if (f.netKobo !== null) return BigInt(f.netKobo);
  if (f.currency === 'NGN' && f.priceMicros !== null && f.priceMicros > 0n) {
    // 1 naira = 1,000,000 micros = 100 kobo.
    const gross = f.priceMicros / 10_000n;
    return (gross * BigInt(10_000 - f.storeFeeBps)) / 10_000n;
  }
  return null;
}

/** A rate as the Hub holds it: `rateKobo` kobo buy `rateCents` US cents. */
export interface UsdRate {
  rateKobo: bigint;
  rateCents: bigint;
  /** Where it came from, kept on every entry. */
  source: string;
}

/** Kobo as US cents at a rate, rounded down. */
export function usdCentsOf(kobo: bigint, rate: UsdRate): bigint {
  return (kobo * rate.rateCents) / rate.rateKobo;
}

/** US cents as whole dollars for words ("US$900,000"). */
export function dollars(cents: bigint): string {
  const d = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `US$${d}`;
}
