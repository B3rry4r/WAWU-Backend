import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  hostShareOfRefund,
  passRefundFigures,
  passRefundReference,
} from './community-pass-rules';
import type { CommunityPassRemovalQuoteView } from './community-pass-view.type';

/**
 * What a host's removal of a member gives back (task INBOX-25, owner ruling
 * Q-43, R-71). Reaches nothing but the database, like the access service, so
 * the community module can use it without the wallet provider's settings; the
 * payout itself is `CommunityPassRefundService`, which registers here to be
 * told when a refund was decided.
 *
 * - **The figures** are the pass's own: the price paid, pro rata, floored in
 *   kobo (price x whole unused days / pass days, a started day counts as
 *   used), summed over the passes the member still has days on. A member who
 *   LEAVES gets nothing: only the host's removal reaches this file.
 * - **Once.** The decision runs inside the removal's own transaction under
 *   the lock the pass grant takes (person and room), and each pass it pays
 *   back is marked with the refund's id in the same write, conditional on the
 *   mark being empty. A double tap, two servers or a retry find the passes
 *   marked and decide nothing. The removal ends the passes it paid back that
 *   moment, so a member the host lets back in has to buy a pass again.
 * - **The host's share** (85% of the refunded sum, R-5) becomes an
 *   `EarningDeduction`, taken from the host's next daily move and never from
 *   their wallet. WAWU's own 15% of those days is WAWU's loss.
 */
@Injectable()
export class CommunityPassRemoval {
  private readonly logger = new Logger(CommunityPassRemoval.name);
  private readonly listeners: Array<(refundId: string) => void> = [];

  constructor(private readonly prisma: PrismaService) {}

  /** The payout service asks to be told, once a refund is written. */
  onDecided(listener: (refundId: string) => void): void {
    this.listeners.push(listener);
  }

  /** Tells the listeners a refund was written (call it after the transaction committed). */
  announce(refundId: string): void {
    for (const listener of this.listeners) {
      try {
        listener(refundId);
      } catch (e) {
        this.logger.error(
          `refund ${refundId}: a listener failed (${e instanceof Error ? e.name : 'error'}); the sweep pays it`,
        );
      }
    }
  }

  /**
   * What removing this member would give back, as of now. Moves nothing and
   * writes nothing. The figure is made again at the moment of removal, so a
   * day that starts between the two can make it one day smaller.
   */
  async quote(
    communityId: string,
    userWawuId: string,
    now: Date = new Date(),
  ): Promise<CommunityPassRemovalQuoteView> {
    const passes = await this.prisma.communityPass.findMany({
      where: { communityId, userWawuId, refundId: null },
      select: { startsAt: true, endsAt: true, priceKobo: true },
    });
    let refund = 0n;
    let unusedDays = 0;
    for (const pass of passes) {
      const f = passRefundFigures(pass, now);
      refund += f.refundKobo;
      unusedDays += f.unusedDays;
    }
    return {
      communityId,
      userWawuId,
      refundKobo: Number(refund),
      unusedDays,
      asOf: now.toISOString(),
    };
  }

  /**
   * Decides the refund of one removal, inside the removal's transaction (the
   * caller has just moved the member out of the room and knows it was THIS
   * call that did). Returns the refund's id, or null when there is nothing to
   * pay back (no pass with days left, or every pass was paid back already).
   */
  async decide(
    tx: Prisma.TransactionClient,
    args: {
      communityId: string;
      hostWawuId: string;
      userWawuId: string;
      now?: Date;
    },
  ): Promise<string | null> {
    const { communityId, hostWawuId, userWawuId } = args;
    const now = args.now ?? new Date();
    // The same lock a pass grant takes: a payment landing now waits for this
    // decision, or is decided before it and is paid back with the rest.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`community-pass:${communityId}:${userWawuId}`}))`;
    const passes = await tx.communityPass.findMany({
      where: { communityId, userWawuId, refundId: null },
      orderBy: [{ endsAt: 'asc' }, { id: 'asc' }],
    });
    const owed = passes
      .map((pass) => ({ pass, figures: passRefundFigures(pass, now) }))
      .filter((p) => p.figures.unusedDays > 0 && p.figures.refundKobo > 0n);
    if (owed.length === 0) return null;

    const amountKobo = owed.reduce((sum, p) => sum + p.figures.refundKobo, 0n);
    const unusedDays = owed.reduce((sum, p) => sum + p.figures.unusedDays, 0);
    const hostShareKobo = hostShareOfRefund(amountKobo);
    const payment = await tx.walletPayment.findUnique({
      where: { id: owed[0].pass.walletPaymentId },
      select: { merchantAccountNumber: true, provider: true },
    });
    if (!payment) {
      throw new Error(
        `Pass ${owed[0].pass.id} has no payment to pay back against.`,
      );
    }

    const id = randomUUID();
    await tx.communityPassRefund.create({
      data: {
        id,
        communityId,
        userWawuId,
        hostWawuId,
        removedAt: now,
        unusedDays,
        amountKobo,
        hostShareKobo,
        merchantAccountNumber: payment.merchantAccountNumber,
        provider: payment.provider,
        customerReference: passRefundReference(id, 1),
      },
    });
    if (hostShareKobo > 0n) {
      await tx.earningDeduction.create({
        data: {
          payeeWawuUserId: hostWawuId,
          passRefundId: id,
          amountKobo: hostShareKobo,
          provider: payment.provider,
        },
      });
    }
    // Each pass paid back is marked, once, and ended this moment. The mark is
    // conditional: a pass another server marked first stops this removal, and
    // the whole transaction goes with it.
    for (const { pass } of owed) {
      const started = pass.startsAt.getTime() <= now.getTime();
      const { count } = await tx.communityPass.updateMany({
        where: { id: pass.id, refundId: null },
        data: {
          refundId: id,
          endsAt: now,
          ...(started ? {} : { startsAt: now }),
        },
      });
      if (count !== 1) {
        throw new Error(
          `Pass ${pass.id} was paid back by another removal a moment ago.`,
        );
      }
    }
    return id;
  }
}
