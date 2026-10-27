/**
 * THE PRICE LADDER (STORE-BUY-HUB, R-101 point 2).
 *
 * In the app, unlocking a piece, sending a tip and getting a community pass are
 * store purchases. Each list price has ONE consumable product on each store,
 * `wawu.buy.<naira>`, used by all three. Its store price is the list price plus
 * the store's cut and the buyer's VAT, rounded up to the store's next price
 * step, so WAWU receives at least the list price. These are the Nigeria prices
 * on the 15% ladder, in whole naira.
 *
 * The migration `20261213090100_store_buy_ladder_rows` writes exactly these rows
 * (`StoreProduct`, both platforms); `store-ladder.spec.ts` checks the two agree.
 * After that the rows belong to the admin (`admin/store/products`): the Hub reads
 * the rows, never this list. The 30% ladder (R-101 point 9) is a later task.
 */
export interface LadderStep {
  /** The list price, whole naira: a price on `prices.list_naira`. */
  listNaira: number;
  /** What the store charges in Nigeria on the 15% ladder, whole naira. */
  storeNaira: number;
}

export const STORE_LADDER: readonly LadderStep[] = [
  { listNaira: 100, storeNaira: 130 },
  { listNaira: 200, storeNaira: 260 },
  { listNaira: 500, storeNaira: 650 },
  { listNaira: 1000, storeNaira: 1300 },
  { listNaira: 1500, storeNaira: 1900 },
  { listNaira: 2000, storeNaira: 2550 },
  { listNaira: 2500, storeNaira: 3200 },
  { listNaira: 3000, storeNaira: 3800 },
  { listNaira: 4000, storeNaira: 5100 },
  { listNaira: 5000, storeNaira: 6400 },
  { listNaira: 7500, storeNaira: 9500 },
  { listNaira: 10000, storeNaira: 12700 },
  { listNaira: 15000, storeNaira: 19000 },
  { listNaira: 20000, storeNaira: 25300 },
  { listNaira: 25000, storeNaira: 31900 },
  { listNaira: 30000, storeNaira: 38000 },
  { listNaira: 40000, storeNaira: 50900 },
  { listNaira: 50000, storeNaira: 63500 },
  { listNaira: 75000, storeNaira: 94900 },
  { listNaira: 100000, storeNaira: 126900 },
  { listNaira: 150000, storeNaira: 189900 },
  { listNaira: 200000, storeNaira: 254900 },
  { listNaira: 250000, storeNaira: 319000 },
  { listNaira: 500000, storeNaira: 649000 },
  { listNaira: 1000000, storeNaira: 1299000 },
];

/** The store product id of a list price, the same on both stores: `wawu.buy.1000`. */
export function buyProductId(listNaira: number): string {
  return `wawu.buy.${listNaira}`;
}

/** True for an id of the ladder's shape. */
export function isBuyProductId(storeProductId: string): boolean {
  return /^wawu\.buy\.[1-9][0-9]*$/.test(storeProductId);
}
