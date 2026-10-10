import { randomUUID } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { NotificationService } from '../notification/notification.service';
import { BlockedAccountService } from '../blocked-account/blocked-account.service';
import {
  ExpoPushClient,
  type ExpoReceipt,
  type ExpoTicket,
} from './expo-push.client';
import { NOW_UTC } from './push-clock';
import {
  EXPO_RECEIPT_CHUNK,
  EXPO_SEND_CHUNK,
  PUSH_BATCH_LIMIT,
  PUSH_DISABLED_KEEP_DAYS,
  PUSH_LOCK_SECONDS,
  PUSH_LOOKBACK_MINUTES,
  PUSH_PRUNE_EVERY_MINUTES,
  PUSH_RECEIPTS,
  PUSH_RETRY,
  PUSH_TTL_SECONDS,
  loadPushSettings,
} from './push-config';
import {
  buildMessage,
  needsPieceTitle,
  type ExpoMessage,
} from './push-message';
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

interface Outgoing {
  delivery: Claimed;
  message: ExpoMessage;
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
  /** Rows the reaper found held by an instance that stopped, put back in the queue. */
  requeued: number;
}

/**
 * The phone push sender (task INBOX-03). It sits BEHIND the notification
 * service and has no write path of its own into notifications:
 *
 *  1. enqueue: a notification the service wrote (the Notification table is the
 *     outbox) becomes one PushDelivery per live phone of its recipient. The
 *     unique key (notification, phone) means any number of hub instances, or
 *     the same instance twice, make exactly one delivery.
 *  2. send, one batch of at most EXPO_SEND_CHUNK at a time: the batch is
 *     claimed (`claimed`, FOR UPDATE SKIP LOCKED, so two instances never hold
 *     the same row), each row is checked again at that moment (the person's
 *     Z3 switch through NotificationService, a block between the person and
 *     whoever the notification is about, a deletion asked for), and only the
 *     rows that will go are marked `sending`, in one statement just before
 *     the request. Expo's answer is recorded in one statement as it arrives.
 *  3. receipts: Expo's receipt for each accepted send is fetched; a
 *     DeviceNotRegistered answer, at either step, disables the phone's token.
 *
 * A stopped instance (crash, deploy, hung request) leaves at most one batch
 * held. The reaper puts a `claimed` row back in the queue (it was never sent),
 * and a `sending` row back ONCE (Expo may have taken it; a second time it is
 * failed). A row a second instance took meanwhile cannot be sent twice: only
 * the claim that holds it may mark it `sending`, and the unique key keeps one
 * row per notification and phone.
 *
 * Every time is the database's clock in UTC (push-clock.ts). Nothing here runs
 * inside a request or a notification write. A failure is recorded on the
 * delivery and logged without any token or message text; it never reaches the
 * caller of `emit()`.
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
    private readonly blocks: BlockedAccountService,
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
      report.requeued = await this.reapStuck();
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

  /**
   * Rows held longer than PUSH_LOCK_SECONDS belong to an instance that
   * stopped. `claimed` never reached Expo: back to the queue, while it has
   * takes left. `sending` may have: back to the queue once, with its attempt
   * count, and failed if it is found mid-send a second time. Returns the
   * number put back.
   */
  async reapStuck(): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ status: string }>>`
      UPDATE "PushDelivery"
      SET "status" = CASE
            WHEN "attempts" >= ${PUSH_RETRY.maxAttempts} THEN 'failed'
            WHEN "status" = 'sending' AND "interruptedSend" THEN 'failed'
            ELSE 'pending' END,
          "reason" = CASE
            WHEN "attempts" >= ${PUSH_RETRY.maxAttempts}
              OR ("status" = 'sending' AND "interruptedSend")
            THEN (CASE WHEN "status" = 'sending' THEN 'send_interrupted' ELSE 'claim_interrupted' END)
            ELSE (CASE WHEN "status" = 'sending' THEN 'requeued_after_send' ELSE 'requeued_after_claim' END) END,
          "interruptedSend" = "interruptedSend" OR "status" = 'sending',
          "nextAttemptAt" = ${NOW_UTC},
          "lockedAt" = NULL,
          "claimId" = NULL,
          "updatedAt" = ${NOW_UTC}
      WHERE "status" IN ('claimed', 'sending')
        AND "lockedAt" < ${NOW_UTC} - make_interval(secs => ${PUSH_LOCK_SECONDS})
      RETURNING "status"`;
    return rows.filter((r) => r.status === 'pending').length;
  }

  /**
   * One delivery per (recent notification of a pushed kind, live phone the
   * recipient has owned since before the notification). `ON CONFLICT DO
   * NOTHING` on the unique key is the whole of the multi-instance safety.
   * An account whose deletion is asked for gets nothing.
   */
  async enqueue(): Promise<number> {
    const kinds = pushedKinds();
    return this.prisma.$executeRaw`
      INSERT INTO "PushDelivery"
        ("id", "notificationId", "userWawuId", "pushTokenId", "status", "nextAttemptAt", "createdAt", "updatedAt")
      SELECT gen_random_uuid()::text, n."id", n."userWawuId", t."id", 'pending', ${NOW_UTC}, ${NOW_UTC}, ${NOW_UTC}
      FROM "Notification" n
      JOIN "PushToken" t
        ON t."userWawuId" = n."userWawuId"
       AND t."disabledAt" IS NULL
       AND n."createdAt" >= t."createdAt"
      WHERE n."createdAt" > ${NOW_UTC} - make_interval(mins => ${PUSH_LOOKBACK_MINUTES})
        AND n."kind" = ANY(${kinds}::text[])
        AND NOT EXISTS (
          SELECT 1 FROM "PushStoppedAccount" s WHERE s."userWawuId" = n."userWawuId")
      ON CONFLICT ("notificationId", "pushTokenId") DO NOTHING`;
  }

  /** Takes at most `limit` due rows for this instance, under one claim id. */
  private async claim(claimId: string, limit: number): Promise<Claimed[]> {
    // The rows are picked once, in a MATERIALIZED CTE. Written as
    // `WHERE id IN (SELECT ... LIMIT n FOR UPDATE SKIP LOCKED)` the planner
    // may run the subquery again for the join, and each run skips what the
    // last one locked, so the UPDATE took more than `n` rows (seen: 250 for
    // a limit of 100, which Expo would refuse as one request).
    return this.prisma.$queryRaw<Claimed[]>`
      WITH picked AS MATERIALIZED (
        SELECT "id" FROM "PushDelivery"
        WHERE "status" = 'pending' AND "nextAttemptAt" <= ${NOW_UTC}
        ORDER BY "createdAt", "id"
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED)
      UPDATE "PushDelivery" d
      SET "status" = 'claimed', "claimId" = ${claimId}, "lockedAt" = ${NOW_UTC},
          "attempts" = d."attempts" + 1, "updatedAt" = ${NOW_UTC}
      FROM picked
      WHERE d."id" = picked."id"
      RETURNING d."id", d."notificationId", d."userWawuId", d."pushTokenId", d."attempts"`;
  }

  /**
   * Sends what is due, one batch at a time, up to PUSH_BATCH_LIMIT. Stops
   * early when Expo is not answering well (a retry or an unknown answer), so
   * a hung Expo holds one batch, not the queue.
   */
  async drain(report: PushRunReport = emptyReport()): Promise<PushRunReport> {
    let taken = 0;
    while (taken < PUSH_BATCH_LIMIT) {
      const claimId = randomUUID();
      const claimed = await this.claim(
        claimId,
        Math.min(EXPO_SEND_CHUNK, PUSH_BATCH_LIMIT - taken),
      );
      if (claimed.length === 0) break;
      taken += claimed.length;
      report.claimed += claimed.length;
      const healthy = await this.sendBatch(claimId, claimed, report);
      if (!healthy || claimed.length < EXPO_SEND_CHUNK) break;
    }
    return report;
  }

  /** Checks, marks `sending`, sends and records one claimed batch. False when Expo did not answer well. */
  private async sendBatch(
    claimId: string,
    claimed: Claimed[],
    report: PushRunReport,
  ): Promise<boolean> {
    const tokens = await this.prisma.pushToken.findMany({
      where: { id: { in: claimed.map((c) => c.pushTokenId) } },
    });
    const tokenById = new Map(tokens.map((t) => [t.id, t]));
    const notes = await this.prisma.notification.findMany({
      where: { id: { in: claimed.map((c) => c.notificationId) } },
      include: { target: true },
    });
    const noteById = new Map(notes.map((n) => [n.id, n]));
    const stopped = new Set(
      (
        await this.prisma.pushStoppedAccount.findMany({
          where: { userWawuId: { in: claimed.map((c) => c.userWawuId) } },
          select: { userWawuId: true },
        })
      ).map((s) => s.userWawuId),
    );
    const pieceIds = notes
      .filter(
        (n) => needsPieceTitle(n.kind) && n.target?.targetKind === 'content',
      )
      .map((n) => n.target!.targetId);
    const pieceTitle = new Map(
      pieceIds.length === 0
        ? []
        : (
            await this.prisma.contentPiece.findMany({
              where: { id: { in: pieceIds } },
              select: { id: true, title: true },
            })
          ).map((p) => [p.id, p.title]),
    );

    const outgoing: Outgoing[] = [];
    const skipped = new Map<string, string[]>();
    for (const delivery of claimed) {
      const token = tokenById.get(delivery.pushTokenId);
      const note = noteById.get(delivery.notificationId);
      const skip = await this.skipReason(delivery, token, note, stopped);
      if (skip) {
        skipped.set(skip, [...(skipped.get(skip) ?? []), delivery.id]);
        continue;
      }
      outgoing.push({
        delivery,
        message: buildMessage(
          {
            id: note!.id,
            kind: note!.kind,
            title: note!.title,
            body: note!.body,
            actionHref: note!.actionHref,
            target: note!.target,
            pieceTitle:
              note!.target?.targetKind === 'content'
                ? (pieceTitle.get(note!.target.targetId) ?? null)
                : null,
          },
          token!.expoPushToken,
        ),
      });
    }
    for (const [reason, ids] of skipped) {
      report.skipped += await this.finish(claimId, ids, 'skipped', reason);
    }
    if (outgoing.length === 0) return true;

    // Only rows this claim still holds go on the wire. A row the reaper put
    // back (and another instance may have taken since) is not sent here.
    const marked = new Set(
      (
        await this.prisma.$queryRaw<Array<{ id: string }>>`
          UPDATE "PushDelivery"
          SET "status" = 'sending', "lockedAt" = ${NOW_UTC}, "updatedAt" = ${NOW_UTC}
          WHERE "id" = ANY(${outgoing.map((o) => o.delivery.id)}::text[])
            AND "status" = 'claimed' AND "claimId" = ${claimId}
          RETURNING "id"`
      ).map((r) => r.id),
    );
    const chunk = outgoing.filter((o) => marked.has(o.delivery.id));
    if (chunk.length === 0) return true;

    const outcome = await this.expo.send(chunk.map((c) => c.message));
    if (outcome.kind === 'tickets') {
      await this.applyTickets(claimId, chunk, outcome.tickets, report);
      return true;
    }
    if (outcome.kind === 'retry') {
      await this.retryOrFail(
        claimId,
        chunk.map((c) => c.delivery.id),
        outcome.reason,
        outcome.retryAfterSeconds,
        report,
      );
      return false;
    }
    if (outcome.kind === 'rejected') {
      this.logger.error(`Expo refused a send request: ${outcome.reason}`);
    }
    const reason =
      outcome.kind === 'unknown'
        ? `send_unconfirmed_${outcome.reason}`
        : outcome.reason;
    report.failed += await this.finish(
      claimId,
      chunk.map((c) => c.delivery.id),
      'failed',
      reason,
    );
    return outcome.kind !== 'unknown';
  }

  /** Why this delivery must not be sent after all, or null to send it. */
  private async skipReason(
    delivery: Claimed,
    token: { userWawuId: string; disabledAt: Date | null } | undefined,
    note:
      | {
          kind: string;
          userWawuId: string;
          read: boolean;
          target: {
            targetKind: string;
            targetId: string;
            actorWawuId: string | null;
          } | null;
        }
      | undefined,
    stopped: Set<string>,
  ): Promise<string | null> {
    if (!token) return 'token_removed';
    if (token.disabledAt) return 'token_disabled';
    if (token.userWawuId !== delivery.userWawuId) return 'token_moved';
    if (!note || note.userWawuId !== delivery.userWawuId)
      return 'notification_gone';
    if (note.read) return 'already_read';
    if (!isPushed(note.kind)) return 'kind_held';
    if (stopped.has(delivery.userWawuId)) return 'account_closing';
    if (await this.involvesBlocked(delivery.userWawuId, note.target)) {
      return 'blocked';
    }
    const gate = pushGateFor(note.kind);
    if (
      gate &&
      (await this.notifications.isSwitchOff(delivery.userWawuId, gate))
    ) {
      return 'switch_off';
    }
    return null;
  }

  /**
   * True when the notification is about a person the recipient blocked or is
   * blocked by: its actor, or a person it opens. Such a push is not sent at
   * all, so no push carries that person's id (lead ruling, 7 Oct 2026, VB-2).
   */
  private async involvesBlocked(
    recipient: string,
    target: {
      targetKind: string;
      targetId: string;
      actorWawuId: string | null;
    } | null,
  ): Promise<boolean> {
    if (!target) return false;
    const people = new Set<string>();
    if (target.actorWawuId) people.add(target.actorWawuId);
    if (target.targetKind === 'profile') people.add(target.targetId);
    people.delete(recipient);
    for (const person of people) {
      if (await this.blocks.isBlockedEitherWay(recipient, person)) return true;
    }
    return false;
  }

  /**
   * Records Expo's tickets the moment they arrive: every accepted one in a
   * single statement, so a stop right after the answer leaves nothing that
   * looks unsent. Then the refusals, one by one. Like every write after the
   * claim, it touches only rows this claim still holds: an answer that comes
   * back after the reaper took a row back (and another instance may be
   * sending it) changes nothing.
   */
  private async applyTickets(
    claimId: string,
    chunk: Outgoing[],
    tickets: ExpoTicket[],
    report: PushRunReport,
  ): Promise<void> {
    const okIds: string[] = [];
    const okTickets: string[] = [];
    const refused: Array<{ delivery: Claimed; code: string }> = [];
    chunk.forEach((item, j) => {
      const ticket = tickets[j];
      if (ticket?.status === 'ok' && typeof ticket.id === 'string') {
        okIds.push(item.delivery.id);
        okTickets.push(ticket.id);
      } else {
        refused.push({
          delivery: item.delivery,
          code:
            ticket?.status === 'error'
              ? (ticket.details?.error ?? 'ticket_error')
              : 'ticket_missing',
        });
      }
    });
    if (okIds.length > 0) {
      report.sent += await this.prisma.$executeRaw`
        UPDATE "PushDelivery" d
        SET "status" = 'sent', "ticketId" = v."ticket", "sentAt" = ${NOW_UTC},
            "receiptDueAt" = ${NOW_UTC} + make_interval(secs => ${PUSH_RECEIPTS.firstCheckSeconds}),
            "lockedAt" = NULL, "claimId" = NULL, "updatedAt" = ${NOW_UTC}
        FROM unnest(${okIds}::text[], ${okTickets}::text[]) AS v("id", "ticket")
        WHERE d."id" = v."id" AND d."status" = 'sending' AND d."claimId" = ${claimId}`;
    }
    for (const { delivery, code } of refused) {
      if (code === 'DeviceNotRegistered') {
        await this.disableToken(delivery.id, code);
        report.tokensDisabled += 1;
      } else if (code === 'InvalidCredentials') {
        this.logger.error(
          'Expo says the push credentials are invalid (FCM key not uploaded to Expo?).',
        );
      } else if (code === 'MessageRateExceeded') {
        await this.retryOrFail(claimId, [delivery.id], code, null, report);
        continue;
      }
      report.failed += await this.finish(
        claimId,
        [delivery.id],
        'failed',
        code,
      );
    }
  }

  /**
   * Puts rows back to be sent again after the backoff, or fails the ones out
   * of attempts. One statement, on the database's clock. An Expo `Retry-After`
   * replaces the backoff but is held to PUSH_RETRY.retryAfterMaxSeconds and to
   * what is left of the delivery's time to live (never below zero), so no
   * value from outside can park a push for a day or overflow a timestamp.
   */
  private async retryOrFail(
    claimId: string,
    ids: string[],
    reason: string,
    retryAfterSeconds: number | null,
    report: PushRunReport,
  ): Promise<void> {
    const rows = await this.prisma.$queryRaw<Array<{ status: string }>>`
      UPDATE "PushDelivery"
      SET "status" = CASE WHEN "attempts" >= ${PUSH_RETRY.maxAttempts} THEN 'failed' ELSE 'pending' END,
          "reason" = CASE WHEN "attempts" >= ${PUSH_RETRY.maxAttempts}
                       THEN ${`retries_exhausted_${reason}`} ELSE ${reason} END,
          "nextAttemptAt" = ${NOW_UTC} + make_interval(secs => CASE
            WHEN ${retryAfterSeconds}::double precision IS NULL
              THEN ${PUSH_RETRY.retryBaseSeconds}::double precision * power(2, GREATEST("attempts" - 1, 0))
            ELSE LEAST(
              ${retryAfterSeconds}::double precision,
              ${PUSH_RETRY.retryAfterMaxSeconds}::double precision,
              GREATEST(EXTRACT(EPOCH FROM (
                "createdAt" + make_interval(secs => ${PUSH_TTL_SECONDS}::double precision) - ${NOW_UTC}
              ))::double precision, 0))
            END),
          "lockedAt" = NULL, "claimId" = NULL, "updatedAt" = ${NOW_UTC}
      WHERE "id" = ANY(${ids}::text[]) AND "status" = 'sending' AND "claimId" = ${claimId}
      RETURNING "status"`;
    for (const r of rows) {
      if (r.status === 'failed') report.failed += 1;
      else report.retried += 1;
    }
  }

  /** Ends rows this claim still holds. Returns how many it ended. */
  private async finish(
    claimId: string,
    ids: string[],
    status: string,
    reason: string,
  ): Promise<number> {
    return this.prisma.$executeRaw`
      UPDATE "PushDelivery"
      SET "status" = ${status}, "reason" = ${reason}, "lockedAt" = NULL,
          "claimId" = NULL, "updatedAt" = ${NOW_UTC}
      WHERE "id" = ANY(${ids}::text[]) AND "claimId" = ${claimId}
        AND "status" <> ALL(${TERMINAL}::text[])`;
  }

  /**
   * Disables the token of a delivery Expo called dead. Only a token the
   * person has owned since before that send is touched (`sentAt`, or for a
   * ticket answered this moment the time the row was marked `sending`): a
   * receipt for a send made before the phone was registered again must not
   * kill the fresh registration. Idempotent. All on the database's clock.
   */
  private async disableToken(
    deliveryId: string,
    reason: string,
  ): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "PushToken" t
      SET "disabledAt" = ${NOW_UTC}, "disabledReason" = ${reason}
      FROM "PushDelivery" d
      WHERE d."id" = ${deliveryId} AND t."id" = d."pushTokenId"
        AND t."disabledAt" IS NULL
        AND t."createdAt" <= COALESCE(d."sentAt", d."lockedAt", ${NOW_UTC})`;
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
      Array<{ id: string; ticketId: string; tooOld: boolean }>
    >`
      WITH picked AS MATERIALIZED (
        SELECT "id" FROM "PushDelivery"
        WHERE "status" = 'sent' AND "receiptDueAt" <= ${NOW_UTC} AND "ticketId" IS NOT NULL
        ORDER BY "receiptDueAt", "id"
        LIMIT ${PUSH_BATCH_LIMIT}
        FOR UPDATE SKIP LOCKED)
      UPDATE "PushDelivery" d
      SET "receiptDueAt" = ${NOW_UTC} + make_interval(secs => ${PUSH_RECEIPTS.retrySeconds}),
          "receiptChecks" = d."receiptChecks" + 1, "updatedAt" = ${NOW_UTC}
      FROM picked
      WHERE d."id" = picked."id"
      RETURNING d."id", d."ticketId",
        (d."sentAt" < ${NOW_UTC} - make_interval(hours => ${PUSH_RECEIPTS.giveUpHours})) AS "tooOld"`;
    if (due.length === 0) return report;
    report.receiptsChecked += due.length;

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
          if (d.tooOld) await this.settleReceipt(d.id, 'expired', 'no_receipt');
          continue;
        }
        if (receipt.status === 'ok') {
          if (await this.settleReceipt(d.id, 'delivered', null))
            report.delivered += 1;
          continue;
        }
        const code = receipt.details?.error ?? 'receipt_error';
        if (code === 'DeviceNotRegistered') {
          await this.disableToken(d.id, code);
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
    const count = await this.prisma.$executeRaw`
      UPDATE "PushDelivery"
      SET "status" = ${status}, "reason" = ${reason}, "updatedAt" = ${NOW_UTC}
      WHERE "id" = ${id} AND "status" = 'sent'`;
    return count > 0;
  }

  /** Dead tokens and finished deliveries do not pile up. At most every PUSH_PRUNE_EVERY_MINUTES per process. */
  async prune(): Promise<void> {
    if (Date.now() - this.lastPruneAt < PUSH_PRUNE_EVERY_MINUTES * 60_000)
      return;
    this.lastPruneAt = Date.now();
    await this.prisma.$executeRaw`
      DELETE FROM "PushToken"
      WHERE "disabledAt" < ${NOW_UTC} - make_interval(days => ${PUSH_DISABLED_KEEP_DAYS})`;
    await this.prisma.$executeRaw`
      DELETE FROM "PushDelivery"
      WHERE "status" = ANY(${TERMINAL}::text[])
        AND "updatedAt" < ${NOW_UTC} - make_interval(days => ${DELIVERY_KEEP_DAYS})`;
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
    requeued: 0,
  };
}
