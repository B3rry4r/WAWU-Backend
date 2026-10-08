import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import type { BillingCurrency } from '../../generated/prisma/enums';
import { PrismaService } from '../common/prisma/prisma.service';

/** A person's billing currency and whether it is fixed yet. */
export interface ResolvedCurrency {
  currency: BillingCurrency;
  /** True once a purchase fixed it (a PersonBilling row exists). */
  fixed: boolean;
}

/**
 * What the WAWU ID token says about where a person is: its `phone` and
 * `country` claims, as they arrive. Either may be missing, null or (from a
 * token nobody should be issuing) not text at all; anything that is not text
 * is read as not given.
 */
export interface BillingClaims {
  phone?: unknown;
  country?: unknown;
}

/** A Prisma client or the transaction a purchase runs in. */
type Db = PrismaService | Prisma.TransactionClient;

/** What a phone number says about its country. */
export type PhoneCountry = 'nigeria' | 'elsewhere' | 'unknown';

/**
 * Reads the country code a phone is written with: `+234` (or `00234`, or the
 * same 13 digits without the plus, `2348031234567`) is Nigeria; any other `+`
 * or `00` code is elsewhere; a number written without a country code
 * (`08031234567`, `(803) 555-0100`) says nothing. WAWU ID stores an app
 * sign-up's Nigerian number as `+234...`, but the web's sign-up keeps the
 * phone as typed and the dial code apart, so a local number is common and
 * cannot be read as Nigerian on its own (a United States `(803) 555-0100`
 * has ten digits that look like a Nigerian mobile).
 */
export function phoneCountry(phone: unknown): PhoneCountry {
  if (typeof phone !== 'string') return 'unknown';
  const d = phone.trim().replace(/[\s\-().]/g, '');
  if (/^(\+|00)234/.test(d) || /^234[789]\d{9}$/.test(d)) return 'nigeria';
  if (/^(\+|00)\d/.test(d)) return 'elsewhere';
  return 'unknown';
}

/**
 * The WAWU ID `country` claim names Nigeria. Sign-up takes it as free text,
 * so `Nigeria`, `NG` and `NGA` in any case, with spaces around, all count.
 */
export function countryIsNigeria(country: unknown): boolean {
  return (
    typeof country === 'string' && /^(nigeria|ng|nga)$/i.test(country.trim())
  );
}

/**
 * Which currency a person is billed in (TIER-01; owner brief v2.0 section 3:
 * "Currency: set at the first purchase from billing country ... Do not switch
 * without support"; lead ruling N1, 8 Oct 2026).
 *
 * The rule, in this order:
 *
 *  1. the currency fixed for the person (a PersonBilling row), whatever has
 *     changed since: a naira wallet opened later, a new phone or a new
 *     country changes nothing;
 *  2. otherwise NGN for a person with a naira wallet;
 *  3. otherwise the phone's country code when it has one: `+234` is NGN, any
 *     other code is USD;
 *  4. a phone with no country code (or none at all) is decided by the
 *     `country` claim: Nigeria is NGN, anything else or nothing is USD.
 *
 * So only a naira wallet, a `+234` number or a Nigerian `country` gives
 * NGN. A person billed in naira only ever sees naira and a person billed in
 * dollars only ever sees dollars (GET /plans picks the one price).
 *
 * Fixing is `fixAtFirstPurchase`, called by the purchase (TIER-03) inside
 * the transaction that records it. There is no method, and no route, that
 * changes a fixed currency: support changes it by hand.
 */
@Injectable()
export class BillingCurrencyService {
  constructor(private readonly prisma: PrismaService) {}

  /** The person's billing currency now: the fixed one, else the rule above. */
  async resolve(
    wawuUserId: string,
    claims: BillingClaims,
    db: Db = this.prisma,
  ): Promise<ResolvedCurrency> {
    const fixed = await db.personBilling.findUnique({
      where: { wawuUserId },
      select: { currency: true },
    });
    if (fixed) return { currency: fixed.currency, fixed: true };
    return {
      currency: await this.unfixed(wawuUserId, claims, db),
      fixed: false,
    };
  }

  /**
   * Fixes the person's currency at their first purchase and answers the one
   * that holds. Inserts only when there is no row (`ON CONFLICT DO NOTHING`):
   * a second purchase, a repeated confirmation or two first purchases at the
   * same moment all leave the first currency in place, and the purchase then
   * prices in what this answers. Never updates a row.
   */
  async fixAtFirstPurchase(
    input: BillingClaims & {
      wawuUserId: string;
      /** The purchase's payment reference. */
      purchaseRef: string;
    },
    db: Db = this.prisma,
  ): Promise<BillingCurrency> {
    const { wawuUserId, purchaseRef } = input;
    const current = await this.resolve(wawuUserId, input, db);
    if (!current.fixed) {
      await db.personBilling.createMany({
        data: [
          {
            wawuUserId,
            currency: current.currency,
            fixedBy: 'first_purchase',
            purchaseRef,
          },
        ],
        skipDuplicates: true,
      });
    }
    const row = await db.personBilling.findUniqueOrThrow({
      where: { wawuUserId },
      select: { currency: true },
    });
    return row.currency;
  }

  /** Rules 2 to 4, for a person with no fixed currency. */
  private async unfixed(
    wawuUserId: string,
    claims: BillingClaims,
    db: Db,
  ): Promise<BillingCurrency> {
    if (await this.hasNairaWallet(wawuUserId, db)) return 'NGN';
    const byPhone = phoneCountry(claims.phone);
    if (byPhone !== 'unknown') return byPhone === 'nigeria' ? 'NGN' : 'USD';
    return countryIsNigeria(claims.country) ? 'NGN' : 'USD';
  }

  /**
   * A naira wallet is an open wallet WAWU records for the person
   * (FintavaWallet, the table the wallet gate reads, MONEY-13). Every wallet
   * there is a naira account today; when dollar accounts arrive (NUV-09)
   * this is where "naira" narrows to them.
   */
  private async hasNairaWallet(wawuUserId: string, db: Db): Promise<boolean> {
    const wallet = await db.fintavaWallet.findUnique({
      where: { wawuUserId },
      select: { wawuUserId: true },
    });
    return wallet !== null;
  }
}
