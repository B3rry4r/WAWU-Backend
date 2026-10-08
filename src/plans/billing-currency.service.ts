import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import type { BillingCurrency } from '../../generated/prisma/enums';
import { PrismaService } from '../common/prisma/prisma.service';
import { toLocalNigerianPhone } from '../wallet-provider/nigerian-phone';

/** A person's billing currency and whether it is fixed yet. */
export interface ResolvedCurrency {
  currency: BillingCurrency;
  /** True once a purchase fixed it (a PersonBilling row exists). */
  fixed: boolean;
}

/** A Prisma client or the transaction a purchase runs in. */
type Db = PrismaService | Prisma.TransactionClient;

/**
 * Which currency a person is billed in (TIER-01; owner brief v2.0 section 3:
 * "Currency: set at the first purchase from billing country ... Do not switch
 * without support").
 *
 * The rule, in this order:
 *
 *  1. the currency fixed for the person (a PersonBilling row), whatever has
 *     changed since: a naira wallet opened later or a new phone changes
 *     nothing;
 *  2. otherwise NGN for a person with a naira wallet or a Nigerian mobile
 *     on their account (the WAWU ID token's `phone`, read the way the money
 *     routes read it, `toLocalNigerianPhone`);
 *  3. otherwise USD.
 *
 * A person billed in naira only ever sees naira and a person billed in
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
    phone: string | null | undefined,
    db: Db = this.prisma,
  ): Promise<ResolvedCurrency> {
    const fixed = await db.personBilling.findUnique({
      where: { wawuUserId },
      select: { currency: true },
    });
    if (fixed) return { currency: fixed.currency, fixed: true };
    return {
      currency: await this.unfixed(wawuUserId, phone, db),
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
    input: {
      wawuUserId: string;
      phone: string | null | undefined;
      /** The purchase's payment reference. */
      purchaseRef: string;
    },
    db: Db = this.prisma,
  ): Promise<BillingCurrency> {
    const { wawuUserId, phone, purchaseRef } = input;
    const current = await this.resolve(wawuUserId, phone, db);
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

  /** Rule 2 and 3, for a person with no fixed currency. */
  private async unfixed(
    wawuUserId: string,
    phone: string | null | undefined,
    db: Db,
  ): Promise<BillingCurrency> {
    if (phone && toLocalNigerianPhone(phone)) return 'NGN';
    return (await this.hasNairaWallet(wawuUserId, db)) ? 'NGN' : 'USD';
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
