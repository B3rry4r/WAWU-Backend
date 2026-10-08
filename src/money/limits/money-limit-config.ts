import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FEE_QUOTE_KINDS, type FeeQuoteKind } from '../dto/money-enums';
import { MONEY_LIMIT_NAMES, type MoneyLimitName } from './money-limit-names';

/**
 * WAWU's own limits on moving money, as settings (task NUV-07; R-42: "fees
 * and limits are settings filled in when Nuvion answers"). Nuvion documents
 * no account tiers and publishes no NGN limit, only that it refuses a
 * transfer past a per-transaction, daily or monthly limit of its own; so
 * WAWU's limits are settings the owner fills in, and this file holds NO
 * figure. Unset means no WAWU limit (the provider's own still apply).
 *
 * Per person and per kind of movement, the kinds a fee quote names:
 *
 *   wawu_transfer  a send to another WAWU user
 *   bank_transfer  a send to a bank, or a withdrawal
 *   purchase       anything WAWU sells, paid from the wallet
 *   bill           a bill (off at launch, R-42; kept for a rollback)
 *
 * and per limit: one movement (`per_transaction`), a Lagos calendar day
 * (`daily`) and a Lagos calendar month (`monthly`). The setting for each is
 * `WAWU_LIMIT_<KIND>_<LIMIT>_KOBO`, such as WAWU_LIMIT_BANK_TRANSFER_DAILY_KOBO:
 * a whole number of kobo, 1 or more. A value that is set but unusable, or a
 * per-transaction limit above its daily one, or a daily one above its monthly
 * one, stops the app at boot naming the setting. They apply under either
 * provider.
 */
export const MONEY_LIMIT_KINDS = FEE_QUOTE_KINDS;
export type MoneyLimitKind = FeeQuoteKind;

/** The setting that holds one limit, e.g. WAWU_LIMIT_PURCHASE_MONTHLY_KOBO. */
export function limitConfigKey(
  kind: MoneyLimitKind,
  limit: MoneyLimitName,
): string {
  return `WAWU_LIMIT_${kind.toUpperCase()}_${limit.toUpperCase()}_KOBO`;
}

/** Every limit setting, kind by kind, in the order above. */
export const MONEY_LIMIT_CONFIG_KEYS: readonly string[] =
  MONEY_LIMIT_KINDS.flatMap((kind) =>
    MONEY_LIMIT_NAMES.map((limit) => limitConfigKey(kind, limit)),
  );

/** A limit setting that is set but unusable. Stops the app at boot. */
export class LimitConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LimitConfigError';
  }
}

/** One limit: null when unset (no WAWU limit), else whole kobo, 1 or more. */
export function limitSetting(
  raw: string | undefined | null,
  key: string,
): number | null {
  if (raw === undefined || raw === null || raw.trim() === '') return null;
  const text = raw.trim();
  // \d is the ASCII digits only: ٣ or a full-width 3 is refused.
  const n = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new LimitConfigError(
      `${key} must be a whole number of kobo, 1 or more, or left empty for no limit.`,
    );
  }
  return n;
}

/** Every kind's three limits, null where unset. */
export type MoneyLimitTable = Readonly<
  Record<MoneyLimitKind, Readonly<Record<MoneyLimitName, number | null>>>
>;

/** Reads every limit through `get` (ConfigService.get, or an env map). */
export function readMoneyLimits(
  get: (key: string) => string | undefined | null,
): MoneyLimitTable {
  const table = {} as Record<
    MoneyLimitKind,
    Record<MoneyLimitName, number | null>
  >;
  for (const kind of MONEY_LIMIT_KINDS) {
    const row = {} as Record<MoneyLimitName, number | null>;
    for (const limit of MONEY_LIMIT_NAMES) {
      const key = limitConfigKey(kind, limit);
      row[limit] = limitSetting(get(key), key);
    }
    // A smaller window above a larger one is a typo: one of the two would
    // never be reached. Stop rather than guess which was meant.
    const order: [MoneyLimitName, MoneyLimitName][] = [
      ['per_transaction', 'daily'],
      ['daily', 'monthly'],
      ['per_transaction', 'monthly'],
    ];
    for (const [smaller, larger] of order) {
      const a = row[smaller];
      const b = row[larger];
      if (a !== null && b !== null && a > b) {
        throw new LimitConfigError(
          `${limitConfigKey(kind, smaller)} is above ${limitConfigKey(kind, larger)}.`,
        );
      }
    }
    table[kind] = row;
  }
  return table;
}

/** WAWU's limits, read once at boot. */
@Injectable()
export class MoneyLimitSettings {
  readonly limits: MoneyLimitTable;

  constructor(config: ConfigService) {
    this.limits = readMoneyLimits((key) => config.get<string>(key));
  }

  /** The limit for this kind of movement, or null for none. */
  limitOf(kind: MoneyLimitKind, limit: MoneyLimitName): number | null {
    return this.limits[kind][limit];
  }
}
