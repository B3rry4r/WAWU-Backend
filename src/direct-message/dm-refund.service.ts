import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { NotificationService } from '../notification/notification.service';
import {
  FLUTTERWAVE_CLIENT,
  type FlutterwaveClient,
} from './flutterwave-client.interface';

/**
 * Actually sends the money back.
 *
 * Before this existed, the expiry sweep flipped a DM to `refunded`, logged
 * the ids, emitted a "you have been refunded" notification, and moved on.
 * No refund was ever issued, because nothing in the codebase could issue
 * one. The payer was told a thing that was not true, at the one moment they
 * were owed the truth, and the only record was a log line nobody read.
 *
 * The design follows from three facts about refunds that do not apply to
 * charges, and each one is a rule here:
 *
 *   A refund can be sent twice. A charge that fires twice is caught by the
 *   payer and reversed; a refund that fires twice is our money, gone, and
 *   Flutterwave will process it without complaint. Hence the claim-based
 *   lock: a row is claimed by a conditional write BEFORE any network call,
 *   and no second worker can pick it up.
 *
 *   A refund is asynchronous. Flutterwave answers 200 for "accepted", not
 *   "settled". The payer is told only on settlement, which is why
 *   `submitted` is a state and not an optimistic `settled`.
 *
 *   A refund that cannot be sent is a debt, not an error. When Flutterwave
 *   refuses for good, the row goes to `failed` and stays there, visible, for
 *   a human with a finance login to settle by hand. Retrying forever would
 *   hide it; dropping it would lose it.
 */

/** Give up after this many tries and hand the row to a human. */
export const MAX_REFUND_ATTEMPTS = 5;
/** A claim older than this is assumed dead (process died mid-call) and may be
 *  re-claimed. Comfortably longer than any Flutterwave call should take. */
const CLAIM_STALE_AFTER_MS = 15 * 60 * 1000;
/** Rows per pass. Bounded so one sweep cannot hold the event loop. */
const BATCH = 100;

export interface RefundRunSummary {
  attempted: number;
  settled: number;
  submitted: number;
  failedRetryable: number;
  failedPermanent: number;
}

@Injectable()
export class DmRefundService {
  private readonly logger = new Logger(DmRefundService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(FLUTTERWAVE_CLIENT) private readonly flutterwave: FlutterwaveClient,
    private readonly notifications: NotificationService,
  ) {}

  /**
   * Work through everything owed. Safe to run concurrently with itself: the
   * claim below is what makes that true, not the caller's discipline.
   */
  async processOwedRefunds(): Promise<RefundRunSummary> {
    const summary: RefundRunSummary = {
      attempted: 0,
      settled: 0,
      submitted: 0,
      failedRetryable: 0,
      failedPermanent: 0,
    };

    const staleBefore = new Date(Date.now() - CLAIM_STALE_AFTER_MS);
    const candidates = await this.prisma.directMessage.findMany({
      where: {
        refundStatus: 'owed',
        refundAttempts: { lt: MAX_REFUND_ATTEMPTS },
        OR: [{ refundLockedAt: null }, { refundLockedAt: { lt: staleBefore } }],
      },
      select: { id: true, refundLockedAt: true },
      orderBy: { deadlineAt: 'asc' },
      take: BATCH,
    });

    for (const candidate of candidates) {
      const claimed = await this.claim(candidate.id, candidate.refundLockedAt);
      if (!claimed) continue;
      summary.attempted += 1;
      const outcome = await this.refundOne(claimed);
      summary[outcome] += 1;
    }

    if (summary.attempted > 0) {
      this.logger.log(
        `DM refunds: ${summary.attempted} attempted, ${summary.settled} settled, ` +
          `${summary.submitted} submitted, ${summary.failedRetryable} retryable, ` +
          `${summary.failedPermanent} needing a human`,
      );
    }
    return summary;
  }

  /**
   * Take exclusive ownership of one row, or return null if someone else did.
   *
   * `updateMany` with the previous lock value in the WHERE is the whole
   * mutex: Postgres serialises it, so exactly one caller sees count 1. A
   * read-then-write would let two workers both see `refundLockedAt: null`
   * and both refund the same transaction.
   */
  private async claim(
    id: string,
    previousLock: Date | null,
  ): Promise<{
    id: string;
    amount: number;
    senderWawuId: string;
    flutterwaveTxId: string | null;
    refundAttempts: number;
  } | null> {
    const now = new Date();
    const result = await this.prisma.directMessage.updateMany({
      where: {
        id,
        refundStatus: 'owed',
        refundLockedAt: previousLock,
        refundAttempts: { lt: MAX_REFUND_ATTEMPTS },
      },
      data: { refundLockedAt: now },
    });
    if (result.count === 0) return null;

    return this.prisma.directMessage.findUniqueOrThrow({
      where: { id },
      select: {
        id: true,
        amount: true,
        senderWawuId: true,
        flutterwaveTxId: true,
        refundAttempts: true,
      },
    });
  }

  private async refundOne(dm: {
    id: string;
    amount: number;
    senderWawuId: string;
    flutterwaveTxId: string | null;
    refundAttempts: number;
  }): Promise<'settled' | 'submitted' | 'failedRetryable' | 'failedPermanent'> {
    // No transaction id means the charge predates it being captured. There
    // is no API call to make — the money is real and owed, so this goes
    // straight to a human rather than looping on an attempt that cannot be
    // constructed.
    if (!dm.flutterwaveTxId) {
      await this.markFailed(
        dm.id,
        'No Flutterwave transaction id was captured for this payment, so it cannot be refunded automatically. Refund it by hand from the Flutterwave dashboard using the transaction reference.',
        true,
      );
      return 'failedPermanent';
    }

    let result;
    try {
      result = await this.flutterwave.refundCharge({
        transactionId: dm.flutterwaveTxId,
        amount: dm.amount,
      });
    } catch (error) {
      // A thrown adapter is ambiguous — the refund may or may not have been
      // accepted. Treated as retryable, and the attempt counter is what
      // eventually stops it rather than an unbounded loop.
      const message =
        error instanceof Error ? error.message : 'Refund call threw';
      await this.releaseForRetry(dm.id, message);
      return 'failedRetryable';
    }

    if (result.status === 'settled') {
      await this.markSettled(dm, result.reference);
      return 'settled';
    }

    if (result.status === 'submitted') {
      await this.prisma.directMessage.update({
        where: { id: dm.id },
        data: {
          refundStatus: 'submitted',
          refundReference: result.reference,
          refundAttempts: { increment: 1 },
          refundError: null,
          refundLockedAt: null,
        },
      });
      // Deliberately NO notification here. Flutterwave has the instruction;
      // the payer does not have the money. Telling them now is the exact
      // failure this service was written to remove.
      return 'submitted';
    }

    if (result.permanent) {
      await this.markFailed(
        dm.id,
        result.message ?? 'Flutterwave refused the refund',
        true,
      );
      return 'failedPermanent';
    }

    await this.releaseForRetry(
      dm.id,
      result.message ?? 'Flutterwave refund failed',
    );
    return 'failedRetryable';
  }

  /**
   * Money is back with the payer. This is the ONLY place a refund
   * notification is emitted — the fact and the message are written together
   * so they cannot drift apart.
   */
  private async markSettled(
    dm: { id: string; amount: number; senderWawuId: string },
    reference: string | null,
  ): Promise<void> {
    const updated = await this.prisma.directMessage.updateMany({
      where: { id: dm.id, refundStatus: { in: ['owed', 'submitted'] } },
      data: {
        refundStatus: 'settled',
        refundReference: reference,
        refundedAt: new Date(),
        refundAttempts: { increment: 1 },
        refundError: null,
        refundLockedAt: null,
      },
    });
    // Guarded on the write actually happening, so a webhook and this worker
    // settling the same refund cannot both announce it.
    if (updated.count === 0) return;

    await this.notifications.emit({
      kind: 'dm_refunded',
      userWawuId: dm.senderWawuId,
      amount: dm.amount,
    });
  }

  /** Out of our hands. Stays visible in the finance queue until a human acts. */
  private async markFailed(
    id: string,
    message: string,
    permanent: boolean,
  ): Promise<void> {
    await this.prisma.directMessage.update({
      where: { id },
      data: {
        refundStatus: 'failed',
        refundError: message,
        refundAttempts: permanent ? MAX_REFUND_ATTEMPTS : { increment: 1 },
        refundLockedAt: null,
      },
    });
    this.logger.error(`DM ${id} refund needs a human: ${message}`);
  }

  /**
   * Unlock and leave it `owed` so the next pass retries — unless this was
   * the last attempt, in which case it becomes a human's problem rather than
   * silently sitting in a queue that will never pick it up again.
   */
  private async releaseForRetry(id: string, message: string): Promise<void> {
    const row = await this.prisma.directMessage.update({
      where: { id },
      data: {
        refundAttempts: { increment: 1 },
        refundError: message,
        refundLockedAt: null,
      },
      select: { refundAttempts: true },
    });
    if (row.refundAttempts >= MAX_REFUND_ATTEMPTS) {
      await this.prisma.directMessage.update({
        where: { id },
        data: { refundStatus: 'failed' },
      });
      this.logger.error(
        `DM ${id} refund gave up after ${row.refundAttempts} attempts: ${message}`,
      );
    }
  }

  /**
   * Settle a refund Flutterwave has confirmed out-of-band (their webhook).
   * Idempotent, and the notification is guarded on the write for the same
   * reason as above.
   */
  async settleFromWebhook(reference: string): Promise<boolean> {
    const dm = await this.prisma.directMessage.findFirst({
      where: { refundReference: reference, refundStatus: 'submitted' },
      select: { id: true, amount: true, senderWawuId: true },
    });
    if (!dm) return false;
    await this.markSettled(dm, reference);
    return true;
  }
}
