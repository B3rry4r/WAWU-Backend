import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Paginated } from '../../common/interceptors/response.interceptor';
import type { NotificationCampaignModel } from '../../../generated/prisma/models';
import { NotificationAudience } from '../../../generated/prisma/enums';
import { NotificationService } from '../../notification/notification.service';
import type { NotificationTone } from '../../notification/notification-event';
import type { AdminUserView } from '../auth/admin-user-view.type';
import { assertCampaignDestination } from './campaign-destination';
import type { ComposeCampaignDto } from './dto/compose-campaign.dto';
import type { AdminCampaignQueryDto } from './dto/admin-campaign-query.dto';
import type {
  AdminAudienceView,
  AdminCampaignDispatchView,
  AdminCampaignView,
} from './admin-campaign-view.type';

/**
 * What each audience means in a sentence the dashboard can show, so an admin
 * is not guessing at the difference between `creators` and
 * `unverified_creators` while holding a send button.
 */
const AUDIENCE_COPY: Record<
  NotificationAudience,
  { label: string; description: string }
> = {
  everyone: {
    label: 'Everyone',
    description: 'Every account with a profile on WAWU.',
  },
  creators: {
    label: 'Creators',
    description: 'Every creator account, verified or not.',
  },
  buyers: {
    label: 'Buyers',
    description: 'Accounts that browse and buy, and do not list.',
  },
  unverified_creators: {
    label: 'Unverified creators',
    description: 'Creators who have never had a verification approved.',
  },
  professionals: {
    label: 'Professionals',
    description: 'Accounts with an approved professional profile.',
  },
  unverified_professionals: {
    label: 'Unverified professionals',
    description: 'Approved professionals who have never had a verification approved.',
  },
};

function toView(row: NotificationCampaignModel): AdminCampaignView {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    imageUrl: row.imageUrl,
    actionLabel: row.actionLabel,
    actionHref: row.actionHref,
    tone: row.tone,
    audience: row.audience,
    status: row.status,
    recipientCount: row.recipientCount,
    deliveredCount: row.deliveredCount,
    failureReason: row.failureReason,
    createdByAdminEmail: row.createdByAdminEmail,
    createdByAdminRole: row.createdByAdminRole,
    dispatchedByAdminEmail: row.dispatchedByAdminEmail,
    dispatchedAt: row.dispatchedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Admin notification campaigns - build brief C8's "push notification and
 * promotion channel".
 *
 * Modelled on AdminContentReviewService and AdminEventsService, which is this
 * codebase's existing answer to "an admin does a thing to a row and the trail
 * has to survive them": a resource row, a decision, a side table with the
 * admin's identity snapshotted onto it. No second idiom is invented here.
 *
 * ── THE ONE THING THIS SURFACE DOES THAT NO OTHER ADMIN SURFACE DOES ─────────
 * Every other admin action in this backend touches one row belonging to one
 * person. A dispatch writes into every account at once and cannot be undone:
 * there is no "unsend", because the notification has already been read by the
 * time anybody regrets it. Three consequences, all deliberate:
 *
 *  1. compose and dispatch are SEPARATE calls. A campaign is drafted, read
 *     back, and only then sent. Nothing in this service sends on create.
 *  2. dispatch is claimed with a conditional update, so a double-click, a
 *     retried request or two admins on the same campaign cannot fan it out
 *     twice.
 *  3. both counts are recorded and both are shown. "Sent to 12,000" and
 *     "wrote 9,412 notifications" are different facts and the dashboard gets
 *     both, because the gap between them IS the opt-out rate and hiding it
 *     would be the first step to ignoring it.
 *
 * ── NO MONEY, NO INVENTED FIGURE ─────────────────────────────────────────────
 * Nothing here reads or writes a price, an amount or a rate, and a campaign
 * body is free text typed by a human, so no figure in it comes from this
 * service. `recipientCount` and `deliveredCount` are the only numbers it
 * produces and both are COUNT(*) results from the queries in
 * `resolveAudience` and the insert results from
 * NotificationService.emitCampaign.
 */
@Injectable()
export class AdminNotificationsService {
  private readonly logger = new Logger(AdminNotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
  ) {}

  /**
   * GET /admin/notifications/audiences - every segment with its live size.
   *
   * Exists so the composer can show a real number beside each option before
   * anything is sent. An admin choosing between "Creators" and "Unverified
   * creators" with no idea whether that is 40 accounts or 40,000 is choosing
   * blind, and this is the cheapest possible fix for that.
   */
  async audiences(): Promise<AdminAudienceView[]> {
    const values = Object.values(NotificationAudience);
    return Promise.all(
      values.map(async (audience) => {
        const ids = await this.resolveAudience(audience);
        const optedOut = await this.prisma.notificationSettings.count({
          where: { userWawuId: { in: ids }, promotions: false },
        });
        return {
          audience,
          ...AUDIENCE_COPY[audience],
          size: ids.length,
          optedIn: ids.length - optedOut,
        };
      }),
    );
  }

  /** GET /admin/notifications/campaigns - the send history, newest first. */
  async list(query: AdminCampaignQueryDto): Promise<Paginated<AdminCampaignView>> {
    const where = query.status ? { status: query.status } : {};
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.notificationCampaign.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.perPage,
        take: query.perPage,
      }),
      this.prisma.notificationCampaign.count({ where }),
    ]);
    return {
      items: rows.map(toView),
      currentPage: query.page,
      perPage: query.perPage,
      total,
    };
  }

  /** GET /admin/notifications/campaigns/:id. */
  async detail(id: string): Promise<AdminCampaignView> {
    const row = await this.prisma.notificationCampaign.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('That campaign does not exist.');
    return toView(row);
  }

  /**
   * POST /admin/notifications/campaigns - compose a draft. Sends nothing.
   */
  async compose(dto: ComposeCampaignDto, admin: AdminUserView): Promise<AdminCampaignView> {
    const { actionLabel, actionHref } = this.normaliseAction(dto);

    const row = await this.prisma.notificationCampaign.create({
      data: {
        title: dto.title.trim(),
        body: dto.body.trim(),
        imageUrl: dto.imageUrl?.trim() || null,
        actionLabel,
        actionHref,
        tone: dto.tone,
        audience: dto.audience,
        createdByAdminId: admin.id,
        createdByAdminEmail: admin.email,
        createdByAdminRole: admin.role,
      },
    });

    await this.audit(row.id, 'campaign_created', row.audience, admin);
    return toView(row);
  }

  /**
   * PATCH /admin/notifications/campaigns/:id - edit a draft.
   *
   * Drafts only, and that is the whole point: a sent campaign is a historical
   * record of what people were actually shown. Editing one would leave the
   * audit trail describing a message nobody received.
   */
  async update(
    id: string,
    dto: ComposeCampaignDto,
    admin: AdminUserView,
  ): Promise<AdminCampaignView> {
    const existing = await this.prisma.notificationCampaign.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('That campaign does not exist.');
    if (existing.status !== 'draft' && existing.status !== 'failed') {
      throw new BadRequestException(
        'Only a draft can be edited. A campaign that has been sent is the record of what people were shown.',
      );
    }

    const { actionLabel, actionHref } = this.normaliseAction(dto);

    const row = await this.prisma.notificationCampaign.update({
      where: { id },
      data: {
        title: dto.title.trim(),
        body: dto.body.trim(),
        imageUrl: dto.imageUrl?.trim() || null,
        actionLabel,
        actionHref,
        tone: dto.tone,
        audience: dto.audience,
        status: 'draft',
        failureReason: null,
      },
    });

    await this.audit(row.id, 'campaign_updated', row.audience, admin);
    return toView(row);
  }

  /**
   * POST /admin/notifications/campaigns/:id/dispatch - send it.
   *
   * The irreversible one. Ordered so that every failure mode leaves the
   * campaign in a state somebody can act on:
   *
   *  1. CLAIM the row (`draft|failed -> sending`) with a conditional
   *     updateMany. If the update matched nothing, another request already
   *     has it, and this one refuses instead of sending a second copy. This
   *     is the same idiom AdminEventsService.decide uses to claim an event.
   *  2. Resolve the audience. A campaign with no recipients is NOT an error:
   *     it is marked `sent` with zero delivered, because "nobody matched"
   *     is a true and useful answer, and failing it would invite a retry
   *     that also matches nobody.
   *  3. Write the notifications through NotificationService, which stays the
   *     only writer of that table and applies each recipient's "Offers and
   *     news" preference.
   *  4. Record both counts, the admin, and the time, and write the audit row.
   *
   * If step 3 throws, the campaign is moved to `failed` with the reason on it
   * and a `campaign_failed` audit row, so it is visibly retryable rather than
   * stuck in `sending` forever. Rows already written are kept: those people
   * genuinely received it, and deleting their notifications to make a status
   * column tidy would be worse than an honest partial send.
   */
  async dispatch(id: string, admin: AdminUserView): Promise<AdminCampaignDispatchView> {
    const existing = await this.prisma.notificationCampaign.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('That campaign does not exist.');

    const claimed = await this.prisma.notificationCampaign.updateMany({
      where: { id, status: { in: ['draft', 'failed'] } },
      data: { status: 'sending' },
    });
    if (claimed.count === 0) {
      throw new ConflictException(
        existing.status === 'sending'
          ? 'That campaign is being sent right now.'
          : 'That campaign has already been sent. Compose a new one to send again.',
      );
    }

    try {
      const recipients = await this.resolveAudience(existing.audience);
      const delivered = await this.notifications.emitCampaign(
        {
          id: existing.id,
          title: existing.title,
          body: existing.body,
          tone: existing.tone as NotificationTone,
          imageUrl: existing.imageUrl,
          actionLabel: existing.actionLabel,
          actionHref: existing.actionHref,
        },
        recipients,
      );

      const row = await this.prisma.notificationCampaign.update({
        where: { id },
        data: {
          status: 'sent',
          recipientCount: recipients.length,
          deliveredCount: delivered,
          failureReason: null,
          dispatchedByAdminId: admin.id,
          dispatchedByAdminEmail: admin.email,
          dispatchedAt: new Date(),
        },
      });

      await this.audit(id, 'campaign_dispatched', row.audience, admin, {
        recipientCount: recipients.length,
        deliveredCount: delivered,
      });

      return {
        campaign: toView(row),
        recipientCount: recipients.length,
        deliveredCount: delivered,
        suppressedByPreference: recipients.length - delivered,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(`Campaign ${id} dispatch failed: ${reason}`);
      await this.prisma.notificationCampaign.update({
        where: { id },
        data: { status: 'failed', failureReason: reason },
      });
      await this.audit(id, 'campaign_failed', existing.audience, admin, { reason });
      throw error;
    }
  }

  /**
   * Turn an audience into the list of accounts in it.
   *
   * Every branch is a query against a table this backend owns. There is no
   * estimate, no cached figure and no "roughly": whatever this returns is
   * exactly who will be written to, which is what makes `recipientCount` a
   * number with a writer rather than a number on a screen.
   */
  private async resolveAudience(audience: NotificationAudience): Promise<string[]> {
    const creators = async () =>
      (
        await this.prisma.userProfile.findMany({
          where: { accountType: 'creator' },
          select: { wawuUserId: true },
        })
      ).map((r) => r.wawuUserId);

    const professionals = async () =>
      (
        await this.prisma.professionalProfile.findMany({
          where: { status: 'approved' },
          select: { wawuUserId: true },
          distinct: ['wawuUserId'],
        })
      ).map((r) => r.wawuUserId);

    const verified = async () =>
      new Set(
        (
          await this.prisma.verificationSubmission.findMany({
            where: { status: 'approved' },
            select: { wawuUserId: true },
            distinct: ['wawuUserId'],
          })
        ).map((r) => r.wawuUserId),
      );

    switch (audience) {
      case 'everyone':
        return (
          await this.prisma.userProfile.findMany({ select: { wawuUserId: true } })
        ).map((r) => r.wawuUserId);

      case 'creators':
        return creators();

      case 'buyers':
        return (
          await this.prisma.userProfile.findMany({
            where: { accountType: 'user' },
            select: { wawuUserId: true },
          })
        ).map((r) => r.wawuUserId);

      case 'unverified_creators': {
        const [all, done] = await Promise.all([creators(), verified()]);
        return all.filter((id) => !done.has(id));
      }

      case 'professionals':
        return professionals();

      case 'unverified_professionals': {
        const [all, done] = await Promise.all([professionals(), verified()]);
        return all.filter((id) => !done.has(id));
      }
    }
  }

  /**
   * A button needs both a label and a destination, and the destination has to
   * be on the allowlist. Enforced here rather than only in the DTO so no
   * future caller can reach the write path around the validation pipe.
   */
  private normaliseAction(dto: ComposeCampaignDto): {
    actionLabel: string | null;
    actionHref: string | null;
  } {
    const label = dto.actionLabel?.trim() || null;
    const href = dto.actionHref?.trim() || null;

    if ((label === null) !== (href === null)) {
      throw new BadRequestException(
        'A campaign button needs both a label and a destination, or neither.',
      );
    }
    if (href !== null) assertCampaignDestination(href);
    return { actionLabel: label, actionHref: href };
  }

  private async audit(
    campaignId: string,
    action: 'campaign_created' | 'campaign_updated' | 'campaign_dispatched' | 'campaign_failed',
    audience: NotificationAudience,
    admin: AdminUserView,
    extra: {
      recipientCount?: number;
      deliveredCount?: number;
      reason?: string;
    } = {},
  ): Promise<void> {
    await this.prisma.adminNotificationAudit.create({
      data: {
        campaignId,
        action,
        audience,
        recipientCount: extra.recipientCount ?? null,
        deliveredCount: extra.deliveredCount ?? null,
        reason: extra.reason ?? null,
        actedByAdminId: admin.id,
        actedByAdminEmail: admin.email,
        actedByAdminRole: admin.role,
      },
    });
  }
}
