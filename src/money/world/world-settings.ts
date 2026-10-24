import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import { FX_FIAT_CODES, type FxFiatCode } from '../fx/fx-currencies';
import {
  COUNTRY_CODE,
  DEFAULT_FIRST_CURRENCY,
  isFiatCode,
  parseFirstCurrencyMap,
} from './world-countries';

/**
 * What the world wallet (a person outside Nigeria opening a wallet without a
 * BVN, WALLET-41, R-87) reads from config and from the admin switch.
 *
 * From the environment (a bad value stops the server at start, as the fee
 * settings do):
 * - `WORLD_FIRST_CURRENCY_MAP` and `WORLD_FIRST_CURRENCY_DEFAULT`: the table
 *   of the currency each country is first offered (world-countries.ts).
 * - `WORLD_OPEN_FEE_<CODE>_MINOR`: WAWU's fee for opening, per first-account
 *   currency, in that currency's smallest unit. Default 0 (R-10: the owner
 *   names it). It is only QUOTED here (GET /money/world/options): a person
 *   with no balance cannot be charged at opening, so a fee above 0 is not
 *   taken until the owner rules where it is paid from (BACKEND_GAPS
 *   G-WALLET-41-4).
 * - `WORLD_OPEN_DAILY_LIMIT`: the most new world openings in one UTC day,
 *   all countries together. Unset or 0 is no limit of WAWU's own.
 * - `WORLD_BLOCKED_COUNTRIES`: countries no opening is taken from (a comma
 *   list of codes). Default none: the owner and Nuvion decide.
 * From the admin settings (plan-settings registry, on by default):
 * `world.open.on`, the switch of the whole product.
 */
@Injectable()
export class WorldSettings {
  private readonly logger = new Logger(WorldSettings.name);
  private readonly table: Record<string, FxFiatCode>;
  private readonly fallback: FxFiatCode;
  private readonly fee = new Map<string, bigint>();
  private readonly daily: number | null;
  private readonly blocked: ReadonlySet<string>;

  constructor(
    config: ConfigService,
    private readonly plan: PlanSettingsService,
  ) {
    const get = (k: string) => {
      const v = config.get<string>(k);
      return v === undefined || v.trim() === '' ? null : v.trim();
    };
    this.table = {
      ...DEFAULT_FIRST_CURRENCY,
      ...parseFirstCurrencyMap(get('WORLD_FIRST_CURRENCY_MAP') ?? undefined),
    };
    const fallback = get('WORLD_FIRST_CURRENCY_DEFAULT') ?? 'USD';
    if (!isFiatCode(fallback)) {
      throw new Error(
        'WORLD_FIRST_CURRENCY_DEFAULT must be one of USD, EUR, GBP, CAD, AED, GHS',
      );
    }
    this.fallback = fallback;
    for (const code of FX_FIAT_CODES) {
      const v = get(`WORLD_OPEN_FEE_${code}_MINOR`);
      if (v === null) continue;
      if (!/^\d{1,15}$/.test(v)) {
        throw new Error(
          `WORLD_OPEN_FEE_${code}_MINOR must be a whole number of the currency's smallest unit`,
        );
      }
      if (Number(v) > 0) this.fee.set(code, BigInt(v));
    }
    const lim = get('WORLD_OPEN_DAILY_LIMIT');
    if (lim !== null && !/^\d{1,9}$/.test(lim)) {
      throw new Error('WORLD_OPEN_DAILY_LIMIT must be a whole number');
    }
    this.daily = lim === null || Number(lim) === 0 ? null : Number(lim);
    const blocked = new Set<string>();
    for (const c of (get('WORLD_BLOCKED_COUNTRIES') ?? '').split(',')) {
      const code = c.trim().toUpperCase();
      if (code === '') continue;
      if (!COUNTRY_CODE.test(code)) {
        throw new Error('WORLD_BLOCKED_COUNTRIES must be country codes');
      }
      blocked.add(code);
    }
    this.blocked = blocked;
  }

  /** The currency a country is first offered. */
  suggestedFor(country: string): FxFiatCode {
    return this.table[country] ?? this.fallback;
  }

  openFeeMinor(code: FxFiatCode): bigint {
    return this.fee.get(code) ?? 0n;
  }

  dailyLimit(): number | null {
    return this.daily;
  }

  isBlocked(country: string): boolean {
    return this.blocked.has(country);
  }

  /** The admin switch of the whole product; unreadable counts as off. */
  openOn(): boolean {
    try {
      return this.plan.number('world.open.on') === 1;
    } catch (e) {
      this.logger.error(
        `world: the switch world.open.on could not be read (${e instanceof Error ? e.name : 'error'}); treated as off`,
      );
      return false;
    }
  }
}
