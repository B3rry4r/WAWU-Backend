import { createPublicKey } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FeeConfigError, koboSetting } from '../fees/fee-config';
import { type FeeRule, feeOf, feeRuleSetting } from '../fees/nuvion-fee-config';
import type { AddMoneyRail } from '../../wallet-provider/add-money';

/**
 * Adding money's settings (WALLET-25, WALLET-26; R-84, R-10, R-42).
 *
 * Every figure is a setting; none is written in code except WAWU's own fee,
 * which the owner set at 0 (R-10: "default 0"):
 *
 *   ADD_MONEY_FEE_CARD, ADD_MONEY_FEE_USSD, ADD_MONEY_FEE_OPEN_BANKING
 *       Nuvion's charge on that rail, in kobo: one whole number, or `from:fee`
 *       bands (the same shape as NUVION_FEE_BANK_PAYOUT). NO DEFAULT: Nuvion
 *       publishes no naira schedule. While one is unset, that rail answers
 *       `503 fees_not_set` before anything is sent (R-42: "nothing moves real
 *       money before they are set"). Card and Apple Pay share the card's.
 *   ADD_MONEY_WAWU_FEE
 *       WAWU's fee on top, in kobo, same shape. Default 0.
 *   ADD_MONEY_MIN_KOBO, ADD_MONEY_MAX_KOBO, ADD_MONEY_DAILY_MAX_KOBO
 *       What the wallet may be topped up with: the least and most in one
 *       attempt, and the most one person adds in a Lagos day. 0 or unset: no
 *       limit of WAWU's (Nuvion's own limits still apply).
 *   NUVION_ENCRYPTION_PUBLIC_KEY
 *       Nuvion's public key (PEM), given to the phone so a card is encrypted
 *       there. Public by nature. Unset: card payments are not offered.
 *   ADD_MONEY_RETURN_URL
 *       The https address of the Hub's return page, where Nuvion's hosted pages
 *       send the person back (`<base>/money/add-money/return`). Unset: the
 *       hosted rails (3-D Secure, Apple Pay) are not offered. The bank checkout
 *       (open banking) is never offered for naira: Nuvion takes none.
 *   ADD_MONEY_USSD_CHANNEL
 *       Nuvion's mobile money channel for the person's phone, one that starts
 *       `NG-`. Nuvion lists only Tanzanian and Kenyan channels
 *       (guides__funding-session) and takes no naira by mobile money (its
 *       answer of 27 Oct 2026), so there is none to default to. Unset, or a
 *       channel of another country: USSD is not offered for naira.
 *
 * Read when the server starts: a value that is set and unusable stops it,
 * naming the setting (as the fee settings do).
 */
export const ADD_MONEY_CONFIG_KEYS = {
  feeCard: 'ADD_MONEY_FEE_CARD',
  feeUssd: 'ADD_MONEY_FEE_USSD',
  feeOpenBanking: 'ADD_MONEY_FEE_OPEN_BANKING',
  wawuFee: 'ADD_MONEY_WAWU_FEE',
  minKobo: 'ADD_MONEY_MIN_KOBO',
  maxKobo: 'ADD_MONEY_MAX_KOBO',
  dailyMaxKobo: 'ADD_MONEY_DAILY_MAX_KOBO',
  encryptionKey: 'NUVION_ENCRYPTION_PUBLIC_KEY',
  returnUrl: 'ADD_MONEY_RETURN_URL',
  ussdChannel: 'ADD_MONEY_USSD_CHANNEL',
} as const;

/** The most a limit or a fee setting may hold: a figure a number holds exactly. */
const MAX_KOBO = 100_000_000_000;

/** The public key as a PEM, or null when unset or not a public key. */
export function readPublicKey(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === '') return null;
  const pem = raw.replace(/\\n/g, '\n').trim();
  if (
    !/^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+\n-----END PUBLIC KEY-----$/.test(
      pem,
    )
  ) {
    throw new FeeConfigError(
      `${ADD_MONEY_CONFIG_KEYS.encryptionKey} must be a PEM public key (BEGIN PUBLIC KEY).`,
    );
  }
  return pem;
}

/** The bytes an RSA ciphertext under this key has (its modulus length), or null with no key; an unusable key stops the server. */
export function cipherBytesOf(pem: string | null): number | null {
  if (pem === null) return null;
  try {
    const bits = createPublicKey(pem).asymmetricKeyDetails?.modulusLength;
    if (typeof bits === 'number' && bits >= 1024 && bits % 8 === 0)
      return bits / 8;
  } catch {
    /* falls through to the refusal below */
  }
  throw new FeeConfigError(
    `${ADD_MONEY_CONFIG_KEYS.encryptionKey} must be an RSA public key of 1024 bits or more.`,
  );
}

/** An https address with no query or fragment, or null when unset. */
export function readReturnUrl(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === '') return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new FeeConfigError(
      `${ADD_MONEY_CONFIG_KEYS.returnUrl} must be an https address.`,
    );
  }
  if (u.protocol !== 'https:' || u.search !== '' || u.hash !== '') {
    throw new FeeConfigError(
      `${ADD_MONEY_CONFIG_KEYS.returnUrl} must be an https address with no query.`,
    );
  }
  return u.toString();
}

/** What a quote for one rail holds, or why it cannot be made. */
export type AddMoneyFeeQuote =
  | { ok: true; providerFeeKobo: number; wawuFeeKobo: number }
  | { ok: false; unset: string };

@Injectable()
export class AddMoneySettings {
  private readonly nuvionFees: Readonly<Record<AddMoneyRail, FeeRule | null>>;
  readonly wawuFee: FeeRule;
  readonly minKobo: number;
  readonly maxKobo: number;
  readonly dailyMaxKobo: number;
  readonly cardPublicKey: string | null;
  /** What the key gives a ciphertext, in bytes (256 for RSA-2048); null with no key. A card sent to the Hub must be exactly this long. */
  readonly cardCipherBytes: number | null;
  readonly returnUrl: string | null;
  readonly ussdChannel: string | null;

  constructor(config: ConfigService) {
    const K = ADD_MONEY_CONFIG_KEYS;
    const get = (key: string) => config.get<string>(key);
    const card = feeRuleSetting(get(K.feeCard), K.feeCard);
    this.nuvionFees = {
      card,
      apple_pay: card,
      ussd: feeRuleSetting(get(K.feeUssd), K.feeUssd),
      open_banking: feeRuleSetting(get(K.feeOpenBanking), K.feeOpenBanking),
    };
    this.wawuFee = feeRuleSetting(get(K.wawuFee), K.wawuFee) ?? {
      kind: 'flat',
      feeKobo: 0,
    };
    this.minKobo = koboSetting(get(K.minKobo), K.minKobo, 0, 0, MAX_KOBO);
    this.maxKobo = koboSetting(get(K.maxKobo), K.maxKobo, 0, 0, MAX_KOBO);
    this.dailyMaxKobo = koboSetting(
      get(K.dailyMaxKobo),
      K.dailyMaxKobo,
      0,
      0,
      MAX_KOBO,
    );
    if (this.maxKobo > 0 && this.minKobo > this.maxKobo) {
      throw new FeeConfigError(
        `${K.minKobo} is above ${K.maxKobo}: nobody could add money.`,
      );
    }
    this.cardPublicKey = readPublicKey(get(K.encryptionKey));
    this.cardCipherBytes = cipherBytesOf(this.cardPublicKey);
    this.returnUrl = readReturnUrl(get(K.returnUrl));
    const channel = get(K.ussdChannel)?.trim() ?? '';
    if (channel !== '' && !/^[A-Z]{2}-[A-Z0-9-]{3,30}$/.test(channel)) {
      throw new FeeConfigError(`${K.ussdChannel} must look like NG-MTN-C2B.`);
    }
    // NUVION-FIX 1.3: a channel of another country (KE-, TZ-) cannot take naira, so it is never used for it: USSD is not offered.
    this.ussdChannel = /^NG-/.test(channel) ? channel : null;
  }

  /** The two fees on `amountKobo`, or the setting that is unset. */
  quote(rail: AddMoneyRail, amountKobo: number): AddMoneyFeeQuote {
    const rule = this.nuvionFees[rail];
    if (!rule) {
      const K = ADD_MONEY_CONFIG_KEYS;
      return {
        ok: false,
        unset:
          rail === 'ussd'
            ? K.feeUssd
            : rail === 'open_banking'
              ? K.feeOpenBanking
              : K.feeCard,
      };
    }
    return {
      ok: true,
      providerFeeKobo: feeOf(rule, amountKobo),
      wawuFeeKobo: feeOf(this.wawuFee, amountKobo),
    };
  }
}
