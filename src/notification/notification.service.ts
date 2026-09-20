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
  type NotificationEvent,
  type NotificationKind,
} from './notification-event';

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
 *   promotions      — the nearest candidates (credits_low, trial_ending) are
 *                     operational warnings about a service the user is
 *                     actively using, not marketing. `promotions` also
 *                     defaults to FALSE, so mapping it would silently switch
 *                     the credits warning off for every account on the
 *                     platform.
 *   communityDigest — a periodic digest job that does not exist.
 *
 * Money-settlement kinds (sale, tip_received, dm_received) are intentionally
 * NOT suppressible by any flag: they are the record of a completed
 * transaction, and no notification preference should be able to hide the fact
 * that money changed hands.
 */
const SETTINGS_GATE: Partial<
  Record<NotificationKind, keyof NotificationSettings>
> = {
  new_follower: 'newFollowers',
  dm_deadline: 'dmReminders',
  dm_refunded: 'refunds',
};

/**
 * Prisma model defaults, mirrored for the case where a user has no
 * NotificationSettings row yet (production accounts get one lazily, on their
 * first read/write through NotificationSettingsService). Emitting must never
 * be the thing that creates the row — a write here would put a settings
 * upsert on the hot path of every payment verify.
 */
const SETTINGS_DEFAULTS: Record<keyof NotificationSettings, boolean | string> =
  {
    userWawuId: '',
    newReplies: true,
    newFollowers: true,
    dmReminders: true,
    refunds: true,
    promotions: false,
    communityDigest: true,
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
      return await client.notification.create({
        data: composeNotification(event),
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

  /** POST /notifications/mark-all-read — response.shape: "void". */
  async markAllRead(userWawuId: string): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { userWawuId, read: false },
      data: { read: true },
    });
  }
}
