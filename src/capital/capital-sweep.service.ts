import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../common/prisma/prisma.service';
import { CapitalService } from './capital.service';

/** How many orders one tick looks at, per kind of work. */
const BATCH = 20;

/**
 * Keeps Capital's local side true (task NUV-12), every minute:
 * - a reservation past its time is marked `expired` (the provider's own
 *   reservation lapses by itself; nothing was taken);
 * - an order left `confirming` is read back from the provider and settled
 *   (approved, back to reserved, expired or sent to review);
 * - a holding that is paying out, or has not been read for six hours, is read
 *   again so its state and its payout reach the ledger;
 * - a fee WAWU is owed is taken again (the reference is fixed, so never twice).
 * It moves money only to take WAWU's fee, and asks the provider before every
 * state it writes. Every step is safe to repeat, so two servers may run it.
 */
@Injectable()
export class CapitalSweepService {
  private readonly logger = new Logger(CapitalSweepService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly capital: CapitalService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'capital-sweep' })
  async tick(now = new Date()): Promise<Record<string, number>> {
    const done = { expired: 0, confirming: 0, holdings: 0, fees: 0 };
    if (this.running || !this.capital.available()) return done;
    this.running = true;
    try {
      done.expired = await this.expire(now);
      done.confirming = await this.settleConfirming(now);
      done.holdings = await this.readHoldings(now);
      done.fees = await this.takeFees(now);
    } catch (e) {
      this.logger.error(
        `capital sweep failed (${e instanceof Error ? e.name : 'error'})`,
      );
    } finally {
      this.running = false;
    }
    return done;
  }

  private async expire(now: Date): Promise<number> {
    const { count } = await this.prisma.capitalOrder.updateMany({
      where: {
        state: 'reserved',
        expiresAt: { lt: new Date(now.getTime() - 60_000) },
      },
      data: { state: 'expired' },
    });
    // A reservation that never reached the provider and has not been
    // retried for ten minutes is not an order.
    await this.prisma.capitalOrder.deleteMany({
      where: {
        state: 'reserving',
        nuvionOrderId: null,
        updatedAt: { lt: new Date(now.getTime() - 10 * 60_000) },
      },
    });
    return count;
  }

  private async settleConfirming(now: Date): Promise<number> {
    const rows = await this.prisma.capitalOrder.findMany({
      where: {
        state: 'confirming',
        updatedAt: { lt: new Date(now.getTime() - 20_000) },
      },
      orderBy: { updatedAt: 'asc' },
      take: BATCH,
    });
    for (const row of rows) {
      const wallet = await this.capital.walletOf(row.wawuUserId);
      if (wallet) await this.capital.refresh(wallet, row);
    }
    return rows.length;
  }

  private async readHoldings(now: Date): Promise<number> {
    const rows = await this.prisma.capitalOrder.findMany({
      where: {
        state: 'confirmed',
        NOT: { lifecycle: { in: ['WITHDRAWN', 'CLOSED', 'REFUNDED'] } },
        OR: [
          { lastCheckedAt: null },
          { lastCheckedAt: { lt: new Date(now.getTime() - 6 * 3_600_000) } },
          {
            withdrawRequestedAt: { not: null },
            lastCheckedAt: { lt: new Date(now.getTime() - 30_000) },
          },
        ],
      },
      orderBy: { lastCheckedAt: 'asc' },
      take: BATCH,
    });
    for (const row of rows) {
      const wallet = await this.capital.walletOf(row.wawuUserId);
      if (wallet) await this.capital.refresh(wallet, row);
    }
    return rows.length;
  }

  private async takeFees(now: Date): Promise<number> {
    const rows = await this.prisma.capitalOrder.findMany({
      where: {
        state: 'confirmed',
        feeState: 'owed',
        confirmedAt: { lt: new Date(now.getTime() - 60_000) },
      },
      orderBy: { confirmedAt: 'asc' },
      take: BATCH,
    });
    for (const row of rows) {
      const wallet = await this.capital.walletOf(row.wawuUserId);
      if (wallet) await this.capital.collectFee(row, wallet);
    }
    return rows.length;
  }
}
