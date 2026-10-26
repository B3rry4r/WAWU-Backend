import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import {
  FX_CURRENCIES,
  fxCurrency,
  type FxCurrencyCode,
  type FxQuoteCode,
} from './fx-currencies';

/** The three products an admin switches off one by one. */
export type FxProduct = 'open_account' | 'swap' | 'crypto_send';

/** The currencies a fee or a daily limit can be set for: ours, and the naira side of a swap. */
const CONFIGURABLE: readonly string[] = [
  'NGN',
  ...FX_CURRENCIES.map((c) => c.code),
];

/**
 * What the foreign-currency routes read from config and from the admin
 * switches (task WALLET-21, R-84).
 *
 * From the environment, per currency CODE (`USD`, `USDT` ..., and `NGN` for
 * the naira side of a swap; each figure an integer in that currency's
 * smallest unit; a bad value stops the server at start, as the fee settings
 * do):
 * - `FX_SWAP_FEE_<CODE>_MINOR`: WAWU's fee on a swap out of that currency,
 *   charged on top (R-10). Default 0 until the owner names it.
 * - `FX_SEND_FEE_<CODE>_MINOR`: WAWU's fee on a crypto send. Default 0.
 * - `FX_FEE_COLLECTOR_<CODE>_BAN`: where the fee is paid (a Nuvion account in
 *   that currency). Required for a nonzero fee outside naira; a naira fee goes
 *   to WAWU's operational account, as a naira send's does.
 * - `PAYMENT_FX_FEE_<CODE>_MINOR`: WAWU's conversion fee when a buyer pays a
 *   naira price from that currency (PAY-FX, R-91), charged on top in that
 *   currency and paid to `FX_FEE_COLLECTOR_<CODE>_BAN`. Default 0 (Default
 *   (lead), owner may override).
 * - `PAYMENT_FX_PROVIDER_FEE_<CODE>_MINOR`: the provider's charge on that move
 *   as the quote shows it and the balance check counts it. Default 0: Nuvion
 *   names none on dev (applicable_fee 0, 26 Oct 2026).
 * - `FX_DAILY_LIMIT_<CODE>_MINOR`: the most one person may move out of that
 *   currency in a Lagos day, swaps and sends together. Unset is no limit of
 *   WAWU's own (the provider's limits stand).
 * - `FX_DECIMALS_<CODE>`: places in the smallest unit, to override the
 *   catalogue (a stablecoin's, BACKEND_GAPS G-WALLET-21-1).
 * From the admin settings (plan-settings registry, on by default): the
 * switch of each currency and of each product.
 */
@Injectable()
export class FxSettings {
  private readonly logger = new Logger(FxSettings.name);
  private readonly swapFee = new Map<string, bigint>();
  private readonly sendFee = new Map<string, bigint>();
  private readonly paymentFee = new Map<string, bigint>();
  private readonly paymentProviderFee = new Map<string, bigint>();
  private readonly collector = new Map<string, string>();
  private readonly dailyLimit = new Map<string, bigint>();
  private readonly decimals = new Map<string, number>();

  constructor(
    config: ConfigService,
    private readonly plan: PlanSettingsService,
  ) {
    const get = (k: string) => {
      const v = config.get<string>(k);
      return v === undefined || v.trim() === '' ? null : v.trim();
    };
    const int = (k: string, min: number, max: number): number | null => {
      const v = get(k);
      if (v === null) return null;
      if (!/^\d{1,15}$/.test(v) || Number(v) < min || Number(v) > max) {
        throw new Error(`${k} must be a whole number from ${min} to ${max}`);
      }
      return Number(v);
    };
    for (const code of CONFIGURABLE) {
      const sw = int(`FX_SWAP_FEE_${code}_MINOR`, 0, Number.MAX_SAFE_INTEGER);
      const sd = int(`FX_SEND_FEE_${code}_MINOR`, 0, Number.MAX_SAFE_INTEGER);
      const pf = int(
        `PAYMENT_FX_FEE_${code}_MINOR`,
        0,
        Number.MAX_SAFE_INTEGER,
      );
      const ppf = int(
        `PAYMENT_FX_PROVIDER_FEE_${code}_MINOR`,
        0,
        Number.MAX_SAFE_INTEGER,
      );
      const ban = get(`FX_FEE_COLLECTOR_${code}_BAN`);
      const lim = int(
        `FX_DAILY_LIMIT_${code}_MINOR`,
        1,
        Number.MAX_SAFE_INTEGER,
      );
      const dec = int(`FX_DECIMALS_${code}`, 0, 12);
      if (sw) this.swapFee.set(code, BigInt(sw));
      if (sd) this.sendFee.set(code, BigInt(sd));
      if (pf) this.paymentFee.set(code, BigInt(pf));
      if (ppf) this.paymentProviderFee.set(code, BigInt(ppf));
      if (ban) {
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(ban)) {
          throw new Error(
            `FX_FEE_COLLECTOR_${code}_BAN is not an account number`,
          );
        }
        this.collector.set(code, ban);
      }
      if (lim !== null) this.dailyLimit.set(code, BigInt(lim));
      if (dec !== null) this.decimals.set(code, dec);
      // The naira fee is paid to WAWU's operational account, as a naira send's
      // is (the provider says which); every other currency needs a collector.
      if ((sw || sd || pf) && !ban && code !== 'NGN') {
        throw new Error(
          `A WAWU fee is set for ${code} but FX_FEE_COLLECTOR_${code}_BAN is not: there is nowhere to pay it`,
        );
      }
    }
  }

  /** Places in the currency's smallest unit; NGN is 2. */
  decimalsOf(code: FxQuoteCode): number {
    if (code === 'NGN') return 2;
    return this.decimals.get(code) ?? fxCurrency(code)!.decimals;
  }

  swapFeeMinor(code: FxQuoteCode): bigint {
    return this.swapFee.get(code) ?? 0n;
  }

  /** WAWU's conversion fee on a naira price paid from this currency (PAY-FX); 0 unless set. */
  paymentFeeMinor(code: FxQuoteCode): bigint {
    return this.paymentFee.get(code) ?? 0n;
  }

  /** The provider's charge on a naira price paid from this currency (PAY-FX), from config; 0 unless set. */
  paymentProviderFeeMinor(code: FxQuoteCode): bigint {
    return this.paymentProviderFee.get(code) ?? 0n;
  }

  sendFeeMinor(code: FxCurrencyCode): bigint {
    return this.sendFee.get(code) ?? 0n;
  }

  feeCollector(code: FxQuoteCode): string | null {
    return this.collector.get(code) ?? null;
  }

  dailyLimitMinor(code: FxQuoteCode): bigint | null {
    return this.dailyLimit.get(code) ?? null;
  }

  /** The admin switch of one currency; NGN is always on. */
  currencyOn(code: FxQuoteCode): boolean {
    return code === 'NGN' || this.flag(`fx.currency.${code}.on`);
  }

  productOn(product: FxProduct): boolean {
    return this.flag(`fx.product.${product}.on`);
  }

  private flag(key: string): boolean {
    try {
      return this.plan.number(key) === 1;
    } catch (e) {
      // A setting that cannot be read is off: a switch that cannot be seen is
      // never assumed on.
      this.logger.error(
        `fx: the switch ${key} could not be read (${e instanceof Error ? e.name : 'error'}); treated as off`,
      );
      return false;
    }
  }
}
