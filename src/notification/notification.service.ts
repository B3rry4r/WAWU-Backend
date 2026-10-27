import { randomUUID } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import type {
  Notification,
  NotificationSettings,
  NotificationsResponse,
} from '../common/types';
import { NOW_UTC } from '../push/push-clock';
import {
  composeNotification,
  targetFor,
  type NotificationEvent,
  type NotificationKind,
  type NotificationTone,
} from './notification-event';

/**
 * Rows per INSERT when a campaign fans out. Large enough that a platform-wide
 * send is a handful of statements, small enough that one statement stays well
 * inside Postgres\' parameter limit and does not hold a write lock for long.
 */
const CAMPAIGN_CHUNK = 500;

/**
 * Recipients per set of statements when community message notices are written
 * (FIX-105). The writes for one chunk are a fixed handful of statements
 * whatever the chunk holds.
 */
export const COMMUNITY_NOTICE_CHUNK = 500;

/**
 * One person's share of a window of community messages (FIX-105): how many
 * messages from other people they have not read, the newest one's time, and
 * when they last opened the room.
 */
export interface CommunityMessageEntry {
  userWawuId: string;
  add: number;
  lastMessageAt: Date;
  lastReadAt: Date | null;
}

/**
 * Either the shared client or an interactive-transaction client — same idiom
 * as CreditSpendService.record(). See `emit()` for when passing a `tx` is
 * and is not a good idea.
 */
export type NotificationPrismaClient = PrismaService | Prisma.TransactionClient;

/**
 * A switch a person can turn off: one of the NotificationSettings flags, or
 * `tgifDaily` (HOME-16, Z2 "TGIF each morning"), which is the TGIF preference
 * the app already saves with PATCH /settings/tgif (`TgifPreference.show`).
 * It is not a column of NotificationSettings, so the one reading of it
 * (`isSwitchOff`) knows where it lives.
 */
export type SwitchName = keyof NotificationSettings | 'tgifDaily';

/**
 * Which NotificationSettings flag (if any) suppresses which kind.
 *
 * NotificationSettings has six flags and, before this change, NOTHING in the
 * codebase read any of them — the settings screen wrote preferences into a
 * table no module consulted. Three of the six map onto a kind that actually
 * exists in the twelve-kind vocabulary, and those three are honoured here:
 *
 *   newFollowers  -> new_follower
 *   dmReminders   -> dm_deadline   (the "your 24h window is closing" nudge)
 *   refunds       -> dm_refunded
 *
 * The other three are deliberately NOT wired, because no kind corresponds to
 * them and inventing a mapping would be worse than an honest gap:
 *   newReplies      — would gate "the creator replied to your paid DM", which
 *                     is not one of the twelve kinds and has no emit site.
 *   promotions      — NOW WIRED, to the `campaign` kind that build brief C8
 *                     introduced. It is still not mapped to credits_low:
 *                     that is an operational warning about a service the
 *                     user is actively using, not marketing, and
 *                     switching them off would cost somebody a conversation
 *                     they paid for. The column's default was flipped to TRUE
 *                     with the same change, because a promotion channel whose
 *                     default is off reaches nobody; existing rows were not
 *                     backfilled (see the migration, and DECISIONS.md D17c).
 *   communityDigest — a periodic digest job that does not exist.
 *
 * SETTINGS-07 (the Settings "Money in" and "Reviews" switches) makes `sale`
 * and `tip_received` suppressible by `moneyIn`, and `content_published` and
 * `content_rejected` by `contentReviews`. Suppressing the notification never
 * touches the payment or the review: the money, the ledger row and the
 * content status are written before emit() is called. `dm_received` stays
 * ungated: no switch on the screen covers it.
 *
 * This is the only place a notification is decided, so any push sender
 * (INBOX-03) must send only for a row emit() returned, never from the event.
 */
export const SETTINGS_GATE: Partial<Record<NotificationKind, SwitchName>> = {
  new_follower: 'newFollowers',
  dm_deadline: 'dmReminders',
  dm_refunded: 'refunds',
  campaign: 'promotions',
  // SETTINGS-07. "Money in" covers tips and sales; "Reviews" covers an upload
  // approved or sent back. Both columns are nullable and NULL reads as ON, so
  // nobody who has not touched the switch notices anything.
  tip_received: 'moneyIn',
  sale: 'moneyIn',
  // STORE-SALE-NOTICE (R-101). A pass sold and a question answered through a
  // store are sales; the question credit is the asker's refund in another form.
  pass_sold: 'moneyIn',
  question_answered: 'moneyIn',
  question_credit: 'refunds',
  // WALLET-10. A bank transfer into the person's account is "Money in" too
  // (Z3: "Tips, sales, transfers"). With the switch off nothing is written
  // and nothing is kept to send later; the history row is there either way.
  money_in: 'moneyIn',
  content_published: 'contentReviews',
  content_rejected: 'contentReviews',
  // ME-10. A buyer's star rating is a review too: whoever switched "Reviews"
  // off does not want it. Default (agent), owner may override: the Z3 row's
  // own words are "Approved or sent back" (BACKEND_GAPS, ME-10).
  review_received: 'contentReviews',
  // HOME-16 (R-59). The daily TGIF notice follows the TGIF switch (Z2 "TGIF
  // each morning"): with it off nothing is written, and a notice already
  // written is not pushed.
  tgif_daily: 'tgifDaily',
  // FIX-105 (R-81, closes G-21). Z3 "Community messages" mutes the grouped
  // notice for new messages in a room the person joined: with it off the notice
  // is not written (a notice already written stays in the list) and is not
  // pushed. Any other new kind must add its entry here, or no switch can mute it.
  community_messages: 'communityMessages',
  //
  // INBOX-01's `community_join_approved` and `community_join_declined` are
  // deliberately NOT gated by `communityMessages`: they are not messages in a
  // room but the answer to a request the person made themselves ("We'll let
  // you know when she answers", I31), like `kyc_verified`, which no switch
  // mutes either.
};

/**
 * `verify_reminder` is deliberately absent from SETTINGS_GATE. It is not
 * marketing: it is the state of the reader's own account, and brief B1 asks
 * for it to be persistent and recurring. What stops it being spam is
 * frequency, not a switch - VerificationReminderService sends at most one per
 * account per REMINDER_INTERVAL_DAYS and stops the day the account is
 * verified. That an unverified account cannot silence it is a product
 * decision, recorded in DECISIONS.md D17b rather than left implicit here.
 */

/**
 * Prisma model defaults, mirrored for the case where a user has no
 * NotificationSettings row yet (production accounts get one lazily, on their
 * first read/write through NotificationSettingsService). Emitting must never
 * be the thing that creates the row — a write here would put a settings
 * upsert on the hot path of every payment verify.
 */
const SETTINGS_DEFAULTS: Record<
  keyof NotificationSettings,
  boolean | string | null
> = {
  userWawuId: '',
  newReplies: true,
  newFollowers: true,
  dmReminders: true,
  refunds: true,
  // Mirrors the Prisma default, which C8 flipped to true. An account with no
  // settings row has never been asked, and this is the answer given for it:
  // announcements are on, and the Settings toggle turns them off.
  promotions: true,
  communityDigest: true,
  // NULL = never asked = ON (see the schema). Only an explicit false mutes.
  moneyIn: null,
  contentReviews: null,
  communityMessages: null,
};

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * THE single write path into the Notification table. Nothing else in this
   * codebase may call `prisma.notification.create`.
   *
   * Contract for callers:
   *  - `event.userWawuId` is the RECIPIENT, never the actor;
   *  - call it only once the event is definitively true — after a payment is
   *    verified and the row flipped to `completed`, after a refund sweep has
   *    actually updated the row, never before;
   *  - it NEVER throws. A notification is a side effect of an event, not the
   *    event, so a failed insert must not roll back a settled payment. A
   *    failure is logged and `null` is returned.
   *
   * Returns the written row, or `null` if the user's NotificationSettings
   * suppress this kind (or the write failed).
   *
   * `client` accepts a transaction client for callers that genuinely need
   * the notification to commit or roll back with their own write. Prefer
   * calling AFTER the transaction commits: because `emit` swallows its own
   * errors, a failure inside someone else's transaction would leave that
   * transaction aborted with the caller none the wiser.
   *
   * Trivially callable from another module: NotificationModule is @Global()
   * and exports this service, so an admin-review endpoint on
   * feat/admin-surface only needs `constructor(private readonly
   * notifications: NotificationService)` and
   * `await this.notifications.emit({ kind: 'content_published', userWawuId,
   * contentTitle })` — no module import, no schema change, no new copy.
   */
  async emit(
    event: NotificationEvent,
    client: NotificationPrismaClient = this.prisma,
  ): Promise<Notification | null> {
    try {
      if (!event.userWawuId) return null;
      if (await this.isSuppressed(event.userWawuId, event.kind, client)) {
        return null;
      }
      // ME-10: what it is about goes in the same insert (a nested create),
      // so a notification and its target are written together or not at all.
      const target = targetFor(event);
      return await client.notification.create({
        data: {
          ...composeNotification(event),
          ...(target ? { target: { create: target } } : {}),
        },
      });
    } catch (error) {
      this.logger.error(
        `Failed to emit ${event.kind} notification for ${event.userWawuId}`,
        error instanceof Error ? error.stack : String(error),
      );
      return null;
    }
  }

  /**
   * WALLET-40. `emit()` for a caller whose write must stand or fall with its
   * own transaction (`client`): the notification is written in it and a
   * failure is NOT swallowed, so the caller's transaction is undone with it
   * and tried again. Used where "told once" is the same fact as "the row
   * exists" (the wallet row and its "account number is ready" notice).
   *
   * It does no network call, and the caller must not make one inside the
   * transaction. Returns the written row, or `null` when the person's switch
   * for this kind is off (a kind with no switch is never null).
   */
  async emitOrThrow(
    event: NotificationEvent,
    client: Prisma.TransactionClient,
  ): Promise<Notification | null> {
    if (!event.userWawuId) return null;
    if (await this.isSuppressed(event.userWawuId, event.kind, client)) {
      return null;
    }
    const target = targetFor(event);
    return client.notification.create({
      data: {
        ...composeNotification(event),
        ...(target ? { target: { create: target } } : {}),
      },
    });
  }

  /**
   * Batch form for the sweeps in SchedulerService, which resolve many
   * recipients at once. Sequential on purpose — these run on a cron with no
   * caller waiting, and a burst of parallel inserts is not worth the
   * connection pressure.
   */
  async emitMany(
    events: NotificationEvent[],
    client: NotificationPrismaClient = this.prisma,
  ): Promise<number> {
    let written = 0;
    for (const event of events) {
      if (await this.emit(event, client)) written += 1;
    }
    return written;
  }

  /**
   * Fan one admin-composed campaign out to many recipients (build brief C8).
   *
   * Still the single write path: nothing outside this service calls
   * `prisma.notification.create*`, and the row is still composed by
   * `composeNotification`, so a campaign gets the same shape and the same
   * copy rules as every organic notification.
   *
   * NOT `emitMany`. That one is sequential and does a settings lookup per
   * event, which is right for a cron sweep resolving a handful of recipients
   * and wrong here: a campaign to the whole user base would be one query and
   * one INSERT per account. This resolves the opt-outs in ONE query and
   * writes in batches.
   *
   * Returns the number of rows actually written, which is the recipient count
   * MINUS everyone who has "Offers and news" switched off. Both numbers are
   * recorded on the campaign, because "we sent it to 12,000 people" and "we
   * wrote 9,412 notifications" are different facts and the dashboard shows
   * both rather than picking the flattering one.
   *
   * Errors are NOT swallowed here, unlike `emit()`. A campaign dispatch is
   * the caller's whole job rather than a side effect of somebody else's, so
   * a failure has to reach the admin who pressed Send and the audit trail.
   */
  async emitCampaign(
    campaign: {
      id: string;
      title: string;
      body: string;
      tone: NotificationTone;
      imageUrl: string | null;
      actionLabel: string | null;
      actionHref: string | null;
    },
    recipientWawuIds: readonly string[],
  ): Promise<number> {
    if (recipientWawuIds.length === 0) return 0;

    const optedOut = new Set(
      (
        await this.prisma.notificationSettings.findMany({
          where: {
            userWawuId: { in: [...recipientWawuIds] },
            promotions: false,
          },
          select: { userWawuId: true },
        })
      ).map((r) => r.userWawuId),
    );

    const recipients = recipientWawuIds.filter((id) => !optedOut.has(id));
    if (recipients.length === 0) return 0;

    let written = 0;
    for (let i = 0; i < recipients.length; i += CAMPAIGN_CHUNK) {
      const chunk = recipients.slice(i, i + CAMPAIGN_CHUNK);
      const result = await this.prisma.notification.createMany({
        data: chunk.map((userWawuId) =>
          composeNotification({
            kind: 'campaign',
            userWawuId,
            campaignId: campaign.id,
            title: campaign.title,
            body: campaign.body,
            tone: campaign.tone,
            imageUrl: campaign.imageUrl,
            actionLabel: campaign.actionLabel,
            actionHref: campaign.actionHref,
          }),
        ),
      });
      written += result.count;
    }
    return written;
  }

  /**
   * HOME-16. Write one daily TGIF notice for each of `recipientWawuIds`, in
   * the caller's transaction `client`, and return how many were written.
   *
   * Still the single write path and still composed by `composeNotification`.
   * Like `emitCampaign` it is a batch (two INSERTs and one read of the TGIF
   * switch for the whole list, not three queries a person), and like it
   * errors are NOT swallowed: the caller made the "this day is done for this
   * person" marker in the same transaction, and a failed write must undo the
   * marker so the next run tries again. It does no network call and the
   * caller must not make one inside the transaction.
   *
   * Anyone who has the TGIF switch off right now is left out, the same
   * reading `emit()` and the push sender use.
   */
  async emitTgifDaily(
    event: { day: string; series: string; verseReference: string },
    recipientWawuIds: readonly string[],
    client: Prisma.TransactionClient,
  ): Promise<number> {
    if (recipientWawuIds.length === 0) return 0;
    const off = new Set(
      (
        await client.tgifPreference.findMany({
          where: { userWawuId: { in: [...recipientWawuIds] }, show: false },
          select: { userWawuId: true },
        })
      ).map((r) => r.userWawuId),
    );
    // Someone who switched it off after the job claimed them and before this read
    // is left out, and their claim goes with the notice: they are owed nothing
    // today, but if they switch it back on this morning the next look gives them
    // the day's one notice, instead of finding the marker and writing none
    // (SWEEP-INBOX HOME-16 F1). The claim and this delete share one transaction.
    if (off.size > 0) {
      await client.tgifDailyNotice.deleteMany({
        where: {
          userWawuId: { in: [...off] },
          day: new Date(`${event.day}T00:00:00.000Z`),
        },
      });
    }
    const recipients = recipientWawuIds.filter((id) => !off.has(id));
    if (recipients.length === 0) return 0;

    const rows = recipients.map((userWawuId) => ({
      id: randomUUID(),
      ...composeNotification({ kind: 'tgif_daily', userWawuId, ...event }),
    }));
    const written = await client.notification.createMany({ data: rows });
    await client.notificationTarget.createMany({
      data: rows.map((row) => ({
        notificationId: row.id,
        targetKind: 'tgif_day',
        targetId: event.day,
        actorWawuId: null,
      })),
    });
    return written.count;
  }

  /**
   * FIX-105 (R-81). Fold a window of new community messages into the
   * recipients' grouped notices, in the caller's chunks of at most
   * COMMUNITY_NOTICE_CHUNK people. Still the single write path, still composed
   * by `composeNotification`.
   *
   * A person with an OPEN notice for this room (an unread one, newer than the
   * last time they opened the room) has that notice UPDATED: its count goes up
   * and its time moves to now. A person without one gets a new notice. A
   * notice the person has read, or that is older than their last visit to the
   * room, is closed, and the next message starts a new one. Nobody whose
   * "Community messages" switch is off is written to or changed (an unread
   * notice of theirs stays as it is). The caller counts only messages newer
   * than the person's `countedUpTo` mark for the room, and a notice that
   * already holds this window is left alone, so a window replayed counts once.
   *
   * Bounded: per chunk it reads three tables once (the switches, the open
   * notices) and writes in one transaction with at most six statements, however
   * many people are in the chunk or how many messages were sent. Errors are
   * NOT swallowed: the sweep's window stays unfinished and is tried again.
   * Does no network call.
   */
  async emitCommunityMessages(
    community: { id: string; name: string },
    entries: readonly CommunityMessageEntry[],
    countedUpTo: Date,
  ): Promise<{ created: number; updated: number }> {
    let created = 0;
    let updated = 0;
    const wanted = entries.filter((e) => e.add > 0);
    for (let i = 0; i < wanted.length; i += COMMUNITY_NOTICE_CHUNK) {
      const chunk = wanted.slice(i, i + COMMUNITY_NOTICE_CHUNK);
      const ids = chunk.map((e) => e.userWawuId);
      const [off, open] = await Promise.all([
        this.prisma.notificationSettings.findMany({
          where: { userWawuId: { in: ids }, communityMessages: false },
          select: { userWawuId: true },
        }),
        this.prisma.communityMessageNotice.findMany({
          where: {
            communityId: community.id,
            userWawuId: { in: ids },
            notification: { read: false, kind: 'community_messages' },
          },
          select: {
            notificationId: true,
            userWawuId: true,
            messageCount: true,
            lastMessageAt: true,
            countedUpTo: true,
          },
          orderBy: { lastMessageAt: 'asc' },
        }),
      ]);
      const muted = new Set(off.map((r) => r.userWawuId));
      // The newest open notice of each person; any older unread one is stale.
      const openBy = new Map(open.map((n) => [n.userWawuId, n]));
      // A muted person's notices are left exactly as they are (not marked read).
      const staleIds = new Set(
        open
          .filter((n) => !muted.has(n.userWawuId))
          .map((n) => n.notificationId),
      );

      const toUpdate: Array<{
        notificationId: string;
        count: number;
        lastMessageAt: Date;
        body: string;
      }> = [];
      const toCreate: Array<{
        id: string;
        userWawuId: string;
        count: number;
        lastMessageAt: Date;
      }> = [];
      for (const entry of chunk) {
        if (muted.has(entry.userWawuId)) continue;
        const notice = openBy.get(entry.userWawuId);
        const closed =
          notice !== undefined &&
          entry.lastReadAt !== null &&
          entry.lastReadAt >= notice.lastMessageAt;
        if (notice && !closed) {
          staleIds.delete(notice.notificationId);
          if (notice.countedUpTo >= countedUpTo) continue;
          const count = notice.messageCount + entry.add;
          toUpdate.push({
            notificationId: notice.notificationId,
            count,
            lastMessageAt:
              entry.lastMessageAt > notice.lastMessageAt
                ? entry.lastMessageAt
                : notice.lastMessageAt,
            body: composeNotification({
              kind: 'community_messages',
              userWawuId: entry.userWawuId,
              communityId: community.id,
              communityName: community.name,
              messageCount: count,
            }).body,
          });
        } else {
          toCreate.push({
            id: randomUUID(),
            userWawuId: entry.userWawuId,
            count: entry.add,
            lastMessageAt: entry.lastMessageAt,
          });
        }
      }

      const statements: Prisma.PrismaPromise<unknown>[] = [];
      if (staleIds.size > 0) {
        statements.push(
          this.prisma.notification.updateMany({
            where: { id: { in: [...staleIds] }, read: false },
            data: { read: true },
          }),
        );
      }
      if (toUpdate.length > 0) {
        // The notice moves to the top of the list (its time is now) with its
        // new words; the count beside it moves in the same transaction.
        statements.push(
          this.prisma.$executeRaw`
            UPDATE "Notification" n
            SET "body" = v."body", "createdAt" = ${NOW_UTC}
            FROM unnest(${toUpdate.map((u) => u.notificationId)}::text[], ${toUpdate.map((u) => u.body)}::text[]) AS v("id", "body")
            WHERE n."id" = v."id"`,
          this.prisma.$executeRaw`
            UPDATE "CommunityMessageNotice" c
            SET "messageCount" = v."count",
                "lastMessageAt" = v."lastMessageAt"::timestamp,
                "countedUpTo" = ${countedUpTo.toISOString()}::timestamp
            FROM unnest(${toUpdate.map((u) => u.notificationId)}::text[], ${toUpdate.map((u) => u.count)}::int[], ${toUpdate.map((u) => u.lastMessageAt.toISOString())}::text[]) AS v("id", "count", "lastMessageAt")
            WHERE c."notificationId" = v."id"`,
        );
      }
      if (toCreate.length > 0) {
        const drafts = toCreate.map((c) => ({
          ...c,
          draft: composeNotification({
            kind: 'community_messages',
            userWawuId: c.userWawuId,
            communityId: community.id,
            communityName: community.name,
            messageCount: c.count,
          }),
        }));
        statements.push(
          this.prisma.notification.createMany({
            data: drafts.map((d) => ({ id: d.id, ...d.draft })),
          }),
          this.prisma.notificationTarget.createMany({
            data: drafts.map((d) => ({
              notificationId: d.id,
              targetKind: 'community',
              targetId: community.id,
              actorWawuId: null,
            })),
          }),
          this.prisma.communityMessageNotice.createMany({
            data: drafts.map((d) => ({
              notificationId: d.id,
              userWawuId: d.userWawuId,
              communityId: community.id,
              messageCount: d.count,
              lastMessageAt: d.lastMessageAt,
              countedUpTo,
            })),
          }),
        );
      }
      if (statements.length > 0) await this.prisma.$transaction(statements);
      created += toCreate.length;
      updated += toUpdate.length;
    }
    return { created, updated };
  }

  /**
   * FIX-105 (R-81). The person opened the room: their unread grouped notice
   * for it is read, and the next message after this starts a new one. Never
   * throws, so opening a room cannot fail because of a notice.
   */
  async closeCommunityMessages(
    userWawuId: string,
    communityId: string,
  ): Promise<void> {
    try {
      await this.prisma.notification.updateMany({
        where: {
          userWawuId,
          kind: 'community_messages',
          read: false,
          target: { is: { targetKind: 'community', targetId: communityId } },
        },
        data: { read: true },
      });
    } catch (error) {
      this.logger.error(
        `Failed to close the community message notice for ${userWawuId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private async isSuppressed(
    userWawuId: string,
    kind: NotificationKind,
    client: NotificationPrismaClient,
  ): Promise<boolean> {
    const flag = SETTINGS_GATE[kind];
    if (!flag) return false;
    return this.isSwitchOff(userWawuId, flag, client);
  }

  /**
   * Whether this person has switched `flag` off. The one reading of a Z3
   * switch: `emit()` asks it when a notification is written, and the phone
   * push sender (INBOX-03) asks it again just before it sends, so a switch
   * turned off a second ago is honoured and no second reading of the table
   * exists. A person with no settings row, or a switch never set, is ON.
   */
  async isSwitchOff(
    userWawuId: string,
    flag: SwitchName,
    client: NotificationPrismaClient = this.prisma,
  ): Promise<boolean> {
    if (flag === 'tgifDaily') {
      // No row means the default, which is on (HOME-11).
      const preference = await client.tgifPreference.findUnique({
        where: { userWawuId },
        select: { show: true },
      });
      return preference?.show === false;
    }
    const settings = await client.notificationSettings.findUnique({
      where: { userWawuId },
    });

    const value = settings ? settings[flag] : SETTINGS_DEFAULTS[flag];
    return value === false;
  }

  /**
   * GET /notifications — registry.json response.shape:
   * "{unreadCount, items: PaginatedList<Notification>}". The `items` field
   * is itself the fully-wrapped PaginatedList shape (statusCode/message/
   * data/pagination) per common/types/notification.type.ts's
   * NotificationsResponse — ResponseInterceptor only auto-wraps a
   * *top-level* Paginated<T> return, so the nested pagination envelope is
   * built here explicitly.
   */
  async list(
    userWawuId: string,
    page: number,
    perPage: number,
  ): Promise<NotificationsResponse> {
    const skip = (page - 1) * perPage;

    const [data, total, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where: { userWawuId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: perPage,
      }),
      this.prisma.notification.count({ where: { userWawuId } }),
      this.prisma.notification.count({ where: { userWawuId, read: false } }),
    ]);

    const nextPage = page * perPage < total ? page + 1 : null;

    return {
      unreadCount,
      items: {
        statusCode: 200,
        message: 'OK',
        data,
        pagination: { currentPage: page, nextPage, perPage, total },
      },
    };
  }

  /**
   * POST /notifications/:id/read — mark ONE notification read.
   *
   * The only way to clear an unread dot used to be "Mark all read". Opening a
   * notification navigated away and left its dot lit, so the header badge
   * counted things the reader had already dealt with, and the only way to fix
   * that was to declare everything read including the things they had not.
   *
   * Scoped by `userWawuId` as well as `id`, so one account cannot mark
   * another's notification read. A row that is already read, or belongs to
   * somebody else, or does not exist, all produce the same silent success:
   * this is idempotent by design (the client fires it on open, and a retry
   * must not 404), and a 404 here would leak whether an id exists.
   */
  async markRead(userWawuId: string, id: string): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { id, userWawuId, read: false },
      data: { read: true },
    });
  }

  /** POST /notifications/mark-all-read — response.shape: "void". */
  async markAllRead(userWawuId: string): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { userWawuId, read: false },
      data: { read: true },
    });
  }
}
