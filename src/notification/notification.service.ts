import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import type {
  Notification,
  NotificationSettings,
  NotificationsResponse,
} from '../common/types';
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
 * Either the shared client or an interactive-transaction client — same idiom
 * as CreditSpendService.record(). See `emit()` for when passing a `tx` is
 * and is not a good idea.
 */
export type NotificationPrismaClient = PrismaService | Prisma.TransactionClient;

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
const SETTINGS_GATE: Partial<
  Record<NotificationKind, keyof NotificationSettings>
> = {
  new_follower: 'newFollowers',
  dm_deadline: 'dmReminders',
  dm_refunded: 'refunds',
  campaign: 'promotions',
  // SETTINGS-07. "Money in" covers tips and sales; "Reviews" covers an upload
  // approved or sent back. Both columns are nullable and NULL reads as ON, so
  // nobody who has not touched the switch notices anything.
  tip_received: 'moneyIn',
  sale: 'moneyIn',
  content_published: 'contentReviews',
  content_rejected: 'contentReviews',
  // ME-10. A buyer's star rating is a review too: whoever switched "Reviews"
  // off does not want it. Default (agent), owner may override: the Z3 row's
  // own words are "Approved or sent back" (BACKEND_GAPS, ME-10).
  review_received: 'contentReviews',
  // `communityMessages` is stored (Settings saves it) but gates NOTHING yet:
  // no community message notification kind or sender exists. The task that
  // adds that kind (and any other new kind) must add its entry here, or the
  // switch can never mute it.
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

  private async isSuppressed(
    userWawuId: string,
    kind: NotificationKind,
    client: NotificationPrismaClient,
  ): Promise<boolean> {
    const flag = SETTINGS_GATE[kind];
    if (!flag) return false;

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
