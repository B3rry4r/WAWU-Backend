import type { LadderStep } from '../store-ladder';

/**
 * THE 30% PRICE LADDER (STORE-CUT30, R-101 point 9).
 *
 * When a store's cut goes from 15% to 30% (a store reaches the proceeds
 * threshold in a calendar year), each `wawu.buy.<naira>` product's store price
 * moves to the figure here, so WAWU still receives at least the list price and
 * the creator still keeps exactly 85% of it. Same shape as `STORE_LADDER`, the
 * 15% ladder: the list price, and what the store charges in Nigeria in whole
 * naira, rounded up to the store's next price step.
 *
 * These figures were copied out of the lead's store-price table (its fourth
 * column) once, when this was written, and are the seed: nothing reads that
 * table at runtime. `store-cut30.spec.ts` checks the two ladders line up
 * (same list prices, every 30% price above the 15% one).
 */
export const STORE_LADDER_30: readonly LadderStep[] = [
  { listNaira: 100, storeNaira: 160 },
  { listNaira: 200, storeNaira: 310 },
  { listNaira: 500, storeNaira: 790 },
  { listNaira: 1000, storeNaira: 1550 },
  { listNaira: 1500, storeNaira: 2350 },
  { listNaira: 2000, storeNaira: 3100 },
  { listNaira: 2500, storeNaira: 3850 },
  { listNaira: 3000, storeNaira: 4650 },
  { listNaira: 4000, storeNaira: 6200 },
  { listNaira: 5000, storeNaira: 7700 },
  { listNaira: 7500, storeNaira: 11600 },
  { listNaira: 10000, storeNaira: 15400 },
  { listNaira: 15000, storeNaira: 23100 },
  { listNaira: 20000, storeNaira: 30900 },
  { listNaira: 25000, storeNaira: 38500 },
  { listNaira: 30000, storeNaira: 46500 },
  { listNaira: 40000, storeNaira: 61500 },
  { listNaira: 50000, storeNaira: 76900 },
  { listNaira: 75000, storeNaira: 115900 },
  { listNaira: 100000, storeNaira: 153900 },
  { listNaira: 150000, storeNaira: 234900 },
  { listNaira: 200000, storeNaira: 309000 },
  { listNaira: 250000, storeNaira: 384900 },
  { listNaira: 500000, storeNaira: 799000 },
  { listNaira: 1000000, storeNaira: 1549000 },
];
