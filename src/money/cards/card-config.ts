import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FeeConfigError, koboSetting } from '../fees/fee-config';

/**
 * The WAWU card's settings (task WALLET-31; R-10: the user pays the
 * provider's fee plus WAWU's, both from config, never from the design). Read
 * once when the app starts: a value that is set and wrong stops it there,
 * naming the setting.
 *
 *   NUVION_FEE_CARD_CREATE   kobo. What Nuvion takes from the person's
 *                            account when it makes a card. No default: unset,
 *                            making a card answers `503 fees_not_set` and
 *                            nothing is sent. Dev measured 65,772 (NGN 657.72,
 *                            the same for a virtual and a single-use card).
 *   WAWU_FEE_CARD_KOBO       kobo. WAWU's own fee on top, for a provider that
 *                            is not Nuvion (Fintava). Default 0 (R-10). Under
 *                            Nuvion this is not read: WAWU's fee for making a
 *                            card is the dashboard's `card_issue` fee in force
 *                            (default NGN 5,000, plus VAT when it is on), so an
 *                            admin changes it with history (R-140 point 2).
 *   WALLET_CARD_MAX_ACTIVE   cards a person may hold at once (not blocked, not
 *                            failed). Default 5. Default (lead), owner may
 *                            override.
 *   WALLET_CARD_MAX_PER_DAY  cards a person may ask for in a Lagos day. Default
 *                            10. Default (lead), owner may override.
 *
 * Whether the product is on at all is the admin plan setting `cards.enabled`
 * (1 or 0, default 1), read on every request.
 */
export const CARD_CONFIG_KEYS = {
  providerFee: 'NUVION_FEE_CARD_CREATE',
  wawuFee: 'WAWU_FEE_CARD_KOBO',
  maxActive: 'WALLET_CARD_MAX_ACTIVE',
  maxPerDay: 'WALLET_CARD_MAX_PER_DAY',
} as const;

export const CARDS_ENABLED_SETTING = 'cards.enabled';

export const DEFAULT_CARD_MAX_ACTIVE = 5;
export const DEFAULT_CARD_MAX_PER_DAY = 10;
const MAX_COUNT = 1000;

function count(raw: string | undefined, key: string, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = /^[0-9]+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_COUNT) {
    throw new FeeConfigError(
      `${key} must be a whole number from 1 to ${MAX_COUNT}.`,
    );
  }
  return n;
}

export interface CardSettingValues {
  /** Nuvion's fee for making a card, kobo; null while unset. */
  providerFeeKobo: number | null;
  wawuFeeKobo: number;
  maxActive: number;
  maxPerDay: number;
}

export function readCardSettings(
  get: (key: string) => string | undefined,
): CardSettingValues {
  const K = CARD_CONFIG_KEYS;
  const rawProvider = get(K.providerFee);
  return {
    providerFeeKobo:
      rawProvider === undefined || rawProvider.trim() === ''
        ? null
        : koboSetting(rawProvider, K.providerFee, Number.NaN),
    wawuFeeKobo: koboSetting(get(K.wawuFee), K.wawuFee, 0),
    maxActive: count(get(K.maxActive), K.maxActive, DEFAULT_CARD_MAX_ACTIVE),
    maxPerDay: count(get(K.maxPerDay), K.maxPerDay, DEFAULT_CARD_MAX_PER_DAY),
  };
}

@Injectable()
export class CardSettings implements CardSettingValues {
  readonly providerFeeKobo: number | null;
  readonly wawuFeeKobo: number;
  readonly maxActive: number;
  readonly maxPerDay: number;

  constructor(config: ConfigService) {
    const v = readCardSettings((key) => config.get<string>(key));
    this.providerFeeKobo = v.providerFeeKobo;
    this.wawuFeeKobo = v.wawuFeeKobo;
    this.maxActive = v.maxActive;
    this.maxPerDay = v.maxPerDay;
  }
}
