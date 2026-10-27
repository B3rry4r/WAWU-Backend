import { Injectable } from '@nestjs/common';
import { MoneyError } from '../money/money-error';
import { PlanSettingsService } from '../plan-settings/plan-settings.service';
import {
  PRICE_LIST_KEY,
  PRICE_NOT_ON_LIST_CODE,
  TIP_LIST_KEY,
  nairaNumbers,
  nearestOnList,
  neighbours,
} from './price-list';

const KOBO = 100;

/** ₦ with thousands separators, no decimals. */
function naira(amount: number): string {
  return `₦${amount.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

/**
 * The price list as the Hub applies it (PRICE-LIST, R-101).
 *
 * Both lists are admin settings, read live on every call: a change shows with
 * no restart (this process at once, another within the settings refresh). A
 * list that is not set is a fault of the seed and throws; it is never guessed.
 */
@Injectable()
export class PriceListService {
  constructor(private readonly settings: PlanSettingsService) {}

  /** The price list, in whole naira, lowest first. */
  list(): number[] {
    return this.read(PRICE_LIST_KEY);
  }

  /** The tip list, in whole naira, lowest first. */
  tipList(): number[] {
    return this.read(TIP_LIST_KEY);
  }

  /** The list price nearest to `priceNaira` (the lower on a tie; above the top, the top). */
  nearest(priceNaira: number): number {
    return nearestOnList(this.list(), priceNaira);
  }

  /** True when `priceNaira` is on the price list, or is 0 and `allowFree` is set (R-8). */
  isOnList(priceNaira: number, allowFree = false): boolean {
    if (priceNaira === 0) return allowFree;
    return this.list().includes(priceNaira);
  }

  /**
   * Refuses a price that is not on the price list: `400 price_not_on_list`
   * (the contract's one error shape) with the list prices either side of it.
   * Nothing is saved by the caller that gets here. Free (0) passes only where
   * the caller says R-8 allows it.
   */
  assertOnList(
    priceNaira: number,
    options: { allowFree?: boolean } = {},
  ): void {
    if (this.isOnList(priceNaira, options.allowFree === true)) return;
    const { lower, higher } = neighbours(this.list(), priceNaira);
    const near = [lower, higher].filter((p): p is number => p !== null);
    const message =
      near.length === 0
        ? 'Pick a price from the price list.'
        : `That price is not on the price list. The nearest are ${near.map(naira).join(' and ')}.`;
    throw new MoneyError(PRICE_NOT_ON_LIST_CODE, message, {
      nearestLowerNaira: lower,
      nearestHigherNaira: higher,
    });
  }

  /** The two lists as a client reads them: whole naira and the same in kobo (the app never multiplies money, R-21). */
  view(): PriceListView {
    const item = (priceNaira: number): PriceListItem => ({
      priceNaira,
      priceKobo: priceNaira * KOBO,
    });
    return { prices: this.list().map(item), tips: this.tipList().map(item) };
  }

  private read(key: string): number[] {
    const value = this.settings.value(key);
    if (!Array.isArray(value) || value.length === 0) {
      throw new Error(`The setting ${key} is not set.`);
    }
    return nairaNumbers(value as string[]);
  }
}

/** One price on a list. */
export class PriceListItem {
  /** The price in whole naira, as `price` and `priceNaira` fields take it. */
  priceNaira!: number;
  /** The same price in kobo. */
  priceKobo!: number;
}

/** GET /prices: the lists every price picker draws. */
export class PriceListView {
  /** The price list, lowest first: pieces, paid questions, community passes and event tickets. */
  prices!: PriceListItem[];
  /** The tip list, lowest first. Every tip is also on `prices`. */
  tips!: PriceListItem[];
}
