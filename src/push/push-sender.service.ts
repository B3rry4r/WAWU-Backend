import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { NotificationService } from '../notification/notification.service';
import {
  ExpoPushClient,
  type ExpoReceipt,
  type ExpoTicket,
} from './expo-push.client';
import {
  EXPO_RECEIPT_CHUNK,
  EXPO_SEND_CHUNK,
  PUSH_BATCH_LIMIT,
  PUSH_DISABLED_KEEP_DAYS,
  PUSH_LOCK_SECONDS,
  PUSH_LOOKBACK_MINUTES,
  PUSH_RECEIPTS,
  PUSH_RETRY,
  loadPushSettings,
} from './push-config';
import { buildMessage, type ExpoMessage } from './push-message';
import { isPushed, pushGateFor, pushedKinds } from './push-policy';

/** Delivery states that end a delivery. */
const TERMINAL = ['delivered', 'failed', 'skipped', 'expired'];

/** How long a finished delivery row is kept, in days. */
const DELIVERY_KEEP_DAYS = PUSH_DISABLED_KEEP_DAYS;

interface Claimed {
  id: string;
  notificationId: string;
  userWawuId: string;
  pushTokenId: string;
  attempts: number;
}

export interface PushRunReport {
  enqueued: number;
  claimed: number;
  sent: number;
  skipped: number;
  failed: number;
  retried: number;
  delivered: number;
  receiptsChecked: number;
  tokensDisabled: number;
}

/**
 * The phone push sender (task INBOX-03). It sits BEHIND the notification
 * service and has no write path of its own into notifications:
 *
 *  1. enqueue: a notification the service wrote (the Notification table is the
 *     outbox) becomes one PushDelivery per live phone of its recipient. The
 *     unique key (notification, phone) means any number of hub instances, or
 *     the same instance twice, make exactly one delivery.
 *  2. send: deliveries are claimed with FOR UPDATE SKIP LOCKED, so two
 *     instances never hold the same one. Just before sending, the person's Z3
 *     switch for the kind is read again through NotificationService, so a
 *     switch turned off a second ago is honoured.
 *  3. receipts: Expo's receipt for each accepted send is fetched; a
 *     DeviceNotRegistered answer, at either step, disables the phone's token.
 *
 * Nothing here runs inside a request or a notification write. A failure is
 * recorded on the delivery and logged without any token or message text; it
 * never reaches the caller of `emit()`.
 */
@Injectable()
export class PushSenderService {
  private readonly logger = new Logger(PushSenderService.name);
  private running = false;
  private lastPruneAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
    private readonly expo: ExpoPushClient,
  ) {}

  /**
   * One pass of everything. Returns what it did. Does nothing at all, and
   * touches no table, unless PUSH_ENABLED is `true`. A pass already running
   * in this process is not started twice.
   */
  async runOnce(): Promise<PushRunReport> {
    const report = emptyReport();
    if (!loadPushSettings().on) return report;
    if (this.running) return report;
    this.running = true;
    try {
      await this.reapStuck();
      report.enqueued = await this.enqueue();
      await this.drain(report);
      await this.collectReceipts(report);
      await this.prune();
    } catch (error) {
      this.logger.error(
        'A push pass failed',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.running = false;
    }
    return report;
  }

  /** Deliveries whose sender stopped mid-send are failed, never sent again. */
  async reapStuck(): Promise<number> {
    return this.prisma.$executeRaw`
      UPDATE "PushDelivery"
      SET "status" = 'failed', "reason" = 'send_interrupted', "lockedAt" = NULL, "updatedAt" = now()
      WHERE "status" = 'sending'
        AND "lockedAt" < now() - make_interval(secs => ${PUSH_LOCK_SECONDS})`;
  }

  /**
   * One delivery per (recent notification of a pushed kind, live phone the
   * recipient has owned since before the notification). `ON CONFLICT DO
   * NOTHING` on the unique key is the whole of the multi-instance safety.
   */
  async enqueue(): Promise<number> {
    const kinds = pushedKinds();
    return this.prisma.$executeRaw`
      INSERT INTO "PushDelivery"
        ("id", "notificationId", "userWawuId", "pushTokenId", "status", "nextAttemptAt", "createdAt", "updatedAt")
      SELECT gen_random_uuid()::text, n."id", n."userWawuId", t."id", 'pending', now(), now(), now()
      FROM "Notification" n
      JOIN "PushToken" t
        ON t."userWawuId" = n."userWawuId"
       AND t."disabledAt" IS NULL
       AND n."createdAt" >= t."createdAt"
      WHERE n."createdAt" > now() - make_interval(mins => ${PUSH_LOOKBACK_MINUTES})
        AND n."kind" = ANY(${kinds}::text[])
      ON CONFLICT ("notificationId", "pushTokenId") DO NOTHING`;
  }

  private async claim(): Promise<Claimed[]> {
    return this.prisma.$queryRaw<Claimed[]>`
      UPDATE "PushDelivery" d
      SET "status" = 'sending', "lockedAt" = now(), "attempts" = d."attempts" + 1, "updatedAt" = now()
      WHERE d."id" IN (
        SELECT "id" FROM "PushDelivery"
        WHERE "status" = 'pending' AND "nextAttemptAt" <= now()
        ORDER BY "createdAt", "id"
        LIMIT ${PUSH_BATCH_LIMIT}
        FOR UPDATE SKIP LOCKED)
      RETURNING d."id", d."notificationId", d."userWawuId", d."pushTokenId", d."attempts"`;
  }

  /** Sends what is due. */
  async drain(report: PushRunReport = emptyReport()): Promise<PushRunReport> {
    const claimed = await this.claim();
    report.claimed += claimed.length;
    if (claimed.length === 0) return report;

    const tokens = await this.prisma.pushToken.findMany({
      where: { id: { in: claimed.map((c) => c.pushTokenId) } },
    });
    const tokenById = new Map(tokens.map((t) => [t.id, t]));
    const notes = await this.prisma.notification.findMany({
      where: { id: { in: claimed.map((c) => c.notificationId) } },
      include: { target: true },
    });
    const noteById = new Map(notes.map((n) => [n.id, n]));

    const toSend: Array<{
      delivery: Claimed;
      message: ExpoMessage;
      tokenCreatedAt: Date;
    }> = [];
    for (const delivery of claimed) {
      const token = tokenById.get(delivery.pushTokenId);
      const note = noteById.get(delivery.notificationId);
      const skip = await this.skipReason(delivery, token, note);
      if (skip) {
        await this.finish(delivery.id, 'skipped', skip);
        report.skipped += 1;
        continue;
      }
      toSend.push({
        delivery,
        tokenCreatedAt: token!.createdAt,
        message: buildMessage(
          {
            id: note!.id,
            kind: note!.kind,
            title: note!.title,
            body: note!.body,
            actionHref: note!.actionHref,
            target: note!.target,
          },
          token!.expoPushToken,
        ),
      });
    }

    for (let i = 0; i < toSend.length; i += EXPO_SEND_CHUNK) {
      const chunk = toSend.slice(i, i + EXPO_SEND_CHUNK);
      const outcome = await this.expo.send(chunk.map((c) => c.message));
      if (outcome.kind === 'tickets') {
        for (let j = 0; j < chunk.length; j += 1) {
          await this.applyTicket(chunk[j], outcome.tickets[j], report);
        }
      } else if (outcome.kind === 'retry') {
        for (const item of chunk) {
          await this.retryOrFail(
            item.delivery,
            outcome.reason,
            outcome.retryAfterSeconds,
            report,
          );
        }
      } else {
        if (outcome.kind === 'rejected') {
          this.logger.error(`Expo refused a send request: ${outcome.reason}`);
        }
        const reason =
          outcome.kind === 'unknown'
            ? `send_unconfirmed_${outcome.reason}`
            : outcome.reason;
        for (const item of chunk) {
          await this.finish(item.delivery.id, 'failed', reason);
          report.failed += 1;
        }
      }
    }
    return report;
  }

  /** Why this delivery must not be sent after all, or null to send it. */
  private async skipReason(
    delivery: Claimed,
    token: { userWawuId: string; disabledAt: Date | null } | undefined,
    note: { kind: string; userWawuId: string; read: boolean } | undefined,
  ): Promise<string | null> {
    if (!token) return 'token_removed';
    if (token.disabledAt) return 'token_disabled';
    if (token.userWawuId !== delivery.userWawuId) return 'token_moved';
    if (!note || note.userWawuId !== delivery.userWawuId)
      return 'notification_gone';
    if (note.read) return 'already_read';
    if (!isPushed(note.kind)) return 'kind_held';
    const gate = pushGateFor(note.kind);
    if (
      gate &&
      (await this.notifications.isSwitchOff(delivery.userWawuId, gate))
    ) {
      return 'switch_off';
    }
    return null;
  }

  private async applyTicket(
    item: { delivery: Claimed; tokenCreatedAt: Date },
    ticket: ExpoTicket | undefined,
    report: PushRunReport,
  ): Promise<void> {
    const { delivery } = item;
    if (ticket?.status === 'ok' && typeof ticket.id === 'string') {
      const updated = await this.prisma.pushDelivery.updateMany({
        where: { id: delivery.id, status: 'sending' },
        data: {
          status: 'sent',
          ticketId: ticket.id,
          sentAt: new Date(),
          lockedAt: null,
          receiptDueAt: new Date(
            Date.now() + PUSH_RECEIPTS.firstCheckSeconds * 1000,
          ),
        },
      });
      if (updated.count > 0) report.sent += 1;
      return;
    }
    const code =
      ticket?.status === 'error'
        ? (ticket.details?.error ?? 'ticket_error')
        : 'ticket_missing';
    if (code === 'DeviceNotRegistered') {
      await this.disableToken(delivery.pushTokenId, code, new Date());
      report.tokensDisabled += 1;
    } else if (code === 'InvalidCredentials') {
      this.logger.error(
        'Expo says the push credentials are invalid (FCM key not uploaded to Expo?).',
      );
    } else if (code === 'MessageRateExceeded') {
      await this.retryOrFail(delivery, code, null, report);
      return;
    }
    await this.finish(delivery.id, 'failed', code);
    report.failed += 1;
  }

  private async retryOrFail(
    delivery: Claimed,
    reason: string,
    retryAfterSeconds: number | null,
    report: PushRunReport,
  ): Promise<void> {
    if (delivery.attempts >= PUSH_RETRY.maxAttempts) {
      await this.finish(delivery.id, 'failed', `retries_exhausted_${reason}`);
      report.failed += 1;
      return;
    }
    const wait =
      retryAfterSeconds ??
      PUSH_RETRY.retryBaseSeconds * 2 ** (delivery.attempts - 1);
    await this.prisma.pushDelivery.updateMany({
      where: { id: delivery.id, status: 'sending' },
      data: {
        status: 'pending',
        reason,
        lockedAt: null,
        nextAttemptAt: new Date(Date.now() + wait * 1000),
      },
    });
    report.retried += 1;
  }

  private async finish(
    id: string,
    status: string,
    reason: string,
  ): Promise<void> {
    await this.prisma.pushDelivery.updateMany({
      where: { id, status: { notIn: TERMINAL } },
      data: { status, reason, lockedAt: null },
    });
  }

  /**
   * Disables a token Expo called dead. Only a token the person has owned since
   * before `sentBefore` is touched: a receipt for a send made before the phone
   * was registered again must not kill the fresh registration. Idempotent.
   */
  private async disableToken(
    id: string,
    reason: string,
    sentBefore: Date,
  ): Promise<void> {
    await this.prisma.pushToken.updateMany({
      where: { id, disabledAt: null, createdAt: { lte: sentBefore } },
      data: { disabledAt: new Date(), disabledReason: reason },
    });
  }

  /**
   * Fetches receipts for sends Expo took. The claim moves `receiptDueAt`
   * forward in the same statement (FOR UPDATE SKIP LOCKED), so a second
   * instance, or the next tick, cannot take the same rows until they are due
   * again: one job processes a delivery, and a dead token is disabled once.
   */
  async collectReceipts(
    report: PushRunReport = emptyReport(),
  ): Promise<PushRunReport> {
    const due = await this.prisma.$queryRaw<
      Array<{ id: string; ticketId: string; pushTokenId: string; sentAt: Date }>
    >`
      UPDATE "PushDelivery" d
      SET "receiptDueAt" = now() + make_interval(secs => ${PUSH_RECEIPTS.retrySeconds}),
          "receiptChecks" = d."receiptChecks" + 1, "updatedAt" = now()
      WHERE d."id" IN (
        SELECT "id" FROM "PushDelivery"
        WHERE "status" = 'sent' AND "receiptDueAt" <= now() AND "ticketId" IS NOT NULL
        ORDER BY "receiptDueAt", "id"
        LIMIT ${PUSH_BATCH_LIMIT}
        FOR UPDATE SKIP LOCKED)
      RETURNING d."id", d."ticketId", d."pushTokenId", d."sentAt"`;
    if (due.length === 0) return report;
    report.receiptsChecked += due.length;

    const giveUpBefore = Date.now() - PUSH_RECEIPTS.giveUpHours * 3_600_000;
    for (let i = 0; i < due.length; i += EXPO_RECEIPT_CHUNK) {
      const chunk = due.slice(i, i + EXPO_RECEIPT_CHUNK);
      const outcome = await this.expo.getReceipts(chunk.map((d) => d.ticketId));
      if (outcome.kind === 'failed') {
        this.logger.warn(`Receipt request failed: ${outcome.reason}`);
        continue;
      }
      for (const d of chunk) {
        const receipt: ExpoReceipt | undefined = outcome.receipts[d.ticketId];
        if (!receipt) {
          if (d.sentAt.getTime() < giveUpBefore) {
            await this.settleReceipt(d.id, 'expired', 'no_receipt');
          }
          continue;
        }
        if (receipt.status === 'ok') {
          if (await this.settleReceipt(d.id, 'delivered', null))
            report.delivered += 1;
          continue;
        }
        const code = receipt.details?.error ?? 'receipt_error';
        if (code === 'DeviceNotRegistered') {
          await this.disableToken(d.pushTokenId, code, d.sentAt);
          report.tokensDisabled += 1;
        } else if (code === 'InvalidCredentials') {
          this.logger.error(
            'Expo says the push credentials are invalid (FCM key not uploaded to Expo?).',
          );
        }
        await this.settleReceipt(d.id, 'failed', code);
        report.failed += 1;
      }
    }
    return report;
  }

  private async settleReceipt(
    id: string,
    status: string,
    reason: string | null,
  ): Promise<boolean> {
    const { count } = await this.prisma.pushDelivery.updateMany({
      where: { id, status: 'sent' },
      data: { status, reason },
    });
    return count > 0;
  }

  /** Dead tokens and finished deliveries do not pile up. At most hourly per process. */
  async prune(): Promise<void> {
    if (Date.now() - this.lastPruneAt < 3_600_000) return;
    this.lastPruneAt = Date.now();
    await this.prisma.pushToken.deleteMany({
      where: {
        disabledAt: {
          lt: new Date(Date.now() - PUSH_DISABLED_KEEP_DAYS * 86_400_000),
        },
      },
    });
    await this.prisma.pushDelivery.deleteMany({
      where: {
        status: { in: TERMINAL },
        updatedAt: {
          lt: new Date(Date.now() - DELIVERY_KEEP_DAYS * 86_400_000),
        },
      },
    });
  }
}

function emptyReport(): PushRunReport {
  return {
    enqueued: 0,
    claimed: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    retried: 0,
    delivered: 0,
    receiptsChecked: 0,
    tokensDisabled: 0,
  };
}
