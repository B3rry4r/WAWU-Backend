import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../common/prisma/prisma.service';
import { WalletService } from './wallet.service';

/**
 * The two real rates. Imported as constants rather than written inline: a rate
 * typed into a payout calculation is how somebody eventually gets paid 80%.
 */
const STANDARD_COMMISSION_RATE = 0.15;
const PRO_COMMISSION_RATE = 0.1;

/**
 * MOVES WHAT CREATORS HAVE EARNED INTO THEIR WALLETS.
 *
 * The wallet by itself is an empty account; this is what puts money in it.
 *
 * ── WHY A SWEEP, AND NOT A HOOK ON EACH SALE ──────────────────────────────
 * Crediting from inside the payment webhook would tie a creator's payout to
 * the success of an outbound Flutterwave call made while settling somebody
 * else's card charge. A slow transfer would delay the buyer's unlock; a failed
 * one would either lose the earning or fail a charge that already succeeded.
 *
 * A sweep decouples them. The sale settles as it always did, and the payout
 * follows. It is naturally idempotent: the reference is derived from the SOURCE
 * ROW ("purchase:<id>"), and that reference is unique in the ledger, so a row
 * seen twice funds nothing the second time. Re-running it is safe, which is
 * what makes it recoverable after any failure.
 *
 * ── WHAT IT WILL NOT PAY ──────────────────────────────────────────────────
 * Only money the creator has actually earned and cannot lose:
 *   - a completed Purchase, at the rate snapshotted on that row
 *   - a direct message the creator ANSWERED, since an unanswered one is
 *     refundable until it expires
 *   - community credit spend, which is already settled when it is recorded
 * Anything still refundable stays where it is until it is not.
 */
@Injectable()
export class WalletFundingService {
  private readonly logger = new Logger(WalletFundingService.name);

  /** A ceiling per pass, so a backlog drains steadily rather than all at once. */
  private static readonly MAX_PER_RUN = 100;

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly config: ConfigService,
  ) {}

  private get enabled(): boolean {
    return this.config.get<string>('WALLET_FUNDING') === 'on';
  }

  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'fund-creator-wallets' })
  async run(): Promise<void> {
    if (!this.enabled) return;
    await this.fundPurchases();
    await this.fundAnsweredDms();
    // Anything the webhook never confirmed, asked about directly. Without
    // this a movement we could not confirm stays pending forever.
    const { checked, settled } = await this.wallet.reconcilePending();
    if (settled > 0) {
      this.logger.log(`Reconciled ${settled} of ${checked} pending wallet movements`);
    }
  }

  /**
   * A sale's creator share, at the rate locked in when it was sold.
   *
   * THE LIMIT APPLIES TO UNFUNDED ROWS, and it has to.
   *
   * This first took the 100 oldest completed purchases and filtered the
   * already-funded ones out afterwards. That works exactly until 100 sales
   * have been paid: from then on every run reads the same 100 funded rows,
   * finds nothing to do, and no creator is ever paid again. The sweep would
   * have looked healthy the whole time.
   *
   * So the exclusion is in the query. Raw SQL because the ledger has no
   * relation to Purchase - it references source rows across several tables by
   * (sourceType, sourceId) - and Prisma cannot express "rows with no matching
   * entry" across an unmodelled join.
   */
  private async fundPurchases(): Promise<void> {
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; creatorWawuId: string; amount: number; commissionRate: unknown }>
    >`
      SELECT p."id", p."creatorWawuId", p."amount", p."commissionRate"
        FROM "Purchase" p
       WHERE p."status" = 'completed'
         AND NOT EXISTS (
               SELECT 1 FROM "WalletLedgerEntry" e
                WHERE e."sourceType" = 'purchase' AND e."sourceId" = p."id"
             )
       ORDER BY p."purchasedAt" ASC
       LIMIT ${WalletFundingService.MAX_PER_RUN}
    `;
    await this.credit(
      rows.map((r) => ({
        reference: `purchase:${r.id}`,
        wawuUserId: r.creatorWawuId,
        // The rate SNAPSHOTTED on the row, never the creator's current one:
        // a tier change after the sale must not alter what that sale paid.
        amount: Math.floor(r.amount * (1 - Number(r.commissionRate))),
        sourceType: 'purchase',
        sourceId: r.id,
      })),
    );
  }

  /** A paid message, once the creator has actually replied to it. */
  private async fundAnsweredDms(): Promise<void> {
    // Same reason as fundPurchases: the limit has to apply to what is still
    // unpaid, or the sweep stalls the moment 100 messages have been settled.
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; creatorWawuId: string; amount: number }>
    >`
      SELECT d."id", d."creatorWawuId", d."amount"
        FROM "DirectMessage" d
       WHERE d."status" = 'responded'
         AND NOT EXISTS (
               SELECT 1 FROM "WalletLedgerEntry" e
                WHERE e."sourceType" = 'direct_message' AND e."sourceId" = d."id"
             )
       ORDER BY d."respondedAt" ASC
       LIMIT ${WalletFundingService.MAX_PER_RUN}
    `;
    if (rows.length === 0) return;

    // DirectMessage carries no snapshotted rate, unlike Purchase, so the
    // creator's CURRENT rate applies - which is what CreatorEarningsService
    // already does when it shows the same figure. Resolved per creator here
    // rather than assumed: 85/15 and 90/10 are the two real rates and picking
    // one by hand would eventually pay somebody the wrong share.
    const rates = await this.ratesFor([...new Set(rows.map((r) => r.creatorWawuId))]);

    await this.credit(
      rows.map((r) => ({
        reference: `direct_message:${r.id}`,
        wawuUserId: r.creatorWawuId,
        amount: Math.floor(r.amount * (1 - (rates.get(r.creatorWawuId) ?? STANDARD_COMMISSION_RATE))),
        sourceType: 'direct_message',
        sourceId: r.id,
      })),
    );
  }

  /**
   * The commission rate for each creator, by the same rule the earnings screen
   * uses: Pro tier AND paid gets 90/10, everyone else 85/15.
   */
  private async ratesFor(creatorIds: string[]): Promise<Map<string, number>> {
    const states = await this.prisma.creatorState.findMany({
      where: { wawuUserId: { in: creatorIds } },
      select: { wawuUserId: true, tier: true, subscriptionPaid: true },
    });
    return new Map(
      states.map((s) => [
        s.wawuUserId,
        s.tier === 'pro' && s.subscriptionPaid
          ? PRO_COMMISSION_RATE
          : STANDARD_COMMISSION_RATE,
      ]),
    );
  }

  private async credit(
    items: Array<{
      reference: string;
      wawuUserId: string;
      amount: number;
      sourceType: string;
      sourceId: string;
    }>,
  ): Promise<void> {
    if (items.length === 0) return;

    // One round trip to find what has already been paid, rather than one
    // creditEarning call per row that mostly returns early.
    const seen = new Set(
      (
        await this.prisma.walletLedgerEntry.findMany({
          where: { reference: { in: items.map((i) => i.reference) } },
          select: { reference: true },
        })
      ).map((e) => e.reference),
    );

    for (const item of items) {
      if (seen.has(item.reference) || item.amount <= 0) continue;
      try {
        await this.wallet.creditEarning(item);
      } catch (e) {
        // A creator with no wallet yet is the ordinary case, not a fault: they
        // have earned before finishing KYC, and the money waits for them. Any
        // other failure is worth seeing.
        const message = (e as Error).message;
        if (!message.includes('no wallet')) {
          this.logger.error(`Could not fund ${item.reference}: ${message}`);
        }
      }
    }
  }
}
