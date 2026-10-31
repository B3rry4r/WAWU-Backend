import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { suspendedIds } from '../common/suspension/user-suspension';
import { UserSuspensionService } from '../user-suspension/user-suspension.service';
import { WawuIdClient } from '../common/auth/wawu-id.client';
import { PrismaService } from '../common/prisma/prisma.service';
import type { Paginated } from '../common/interceptors/response.interceptor';
import type { AdminUserView } from '../admin/auth/admin-user-view.type';
import { AdminContentReviewService } from '../admin/content-review/admin-content-review.service';
import type { AdminUgcReportsQueryDto } from './dto/admin-ugc-reports-query.dto';
import type { ResolveUgcReportDto } from './dto/resolve-ugc-report.dto';
import type { SuspensionReason } from '../common/suspension/user-suspension';
import {
  UGC_KIND_LABELS,
  UGC_REASON_LABELS,
  type UgcKind,
  type UgcReason,
} from './ugc-report.kinds';

export interface AdminUgcPerson {
  wawuId: string;
  name: string;
  handle: string | null;
}

/** One reported item in the moderators' list, with the first open report on it and how many there are. */
export interface AdminUgcReportView {
  /** The first open report on the item. `POST /admin/reports/:id/resolve` with it settles every open report on the item. */
  id: string;
  kind: UgcKind;
  kindLabel: string;
  targetId: string;
  /** How many people have an open report on this item. */
  count: number;
  reason: UgcReason;
  reasonLabel: string;
  note: string | null;
  reportedAt: Date;
  lastReportedAt: Date;
  reporter: AdminUgcPerson;
  subject: AdminUgcPerson;
  /** The item as it is now. `exists: false` when it has been deleted since. */
  item: {
    exists: boolean;
    title: string | null;
    excerpt: string | null;
    status: string | null;
  };
  /** True once the support mail was handed to WAWU ID. */
  emailed: boolean;
  /** What a moderator can do with it: every kind can be dismissed; these can also come down. */
  canTakeDown: boolean;
  /** USER-SUSPEND (R-121): the person who made it is suspended right now. */
  subjectSuspended: boolean;
  /** The person can be suspended from here: they are not already, and the Hub still has them. */
  canSuspend: boolean;
}

export interface AdminUgcResolveView {
  id: string;
  kind: UgcKind;
  targetId: string;
  status: 'dismissed' | 'actioned';
  /** How many open reports on the item this settled. */
  resolved: number;
  /** USER-SUSPEND (R-121): the person who made the item is suspended now (by this call, or already). */
  suspended: boolean;
}

/** The kinds whose item a moderator can remove. A profile is not removed: it is suspended with its person. */
const TAKE_DOWN_KINDS: ReadonlySet<UgcKind> = new Set([
  'piece',
  'comment',
  'community_message',
  'chat_message',
]);

const cut = (text: string | null | undefined, max = 240): string | null => {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (t === '') return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/**
 * REPORT-UGC admin side. `GET /admin/reports` lists the open reports, one row per reported item (oldest first) with the
 * item, the first reporter and the count. `POST /admin/reports/:id/resolve` settles them: dismiss, or take the item down.
 *
 * Take-down uses what exists. A piece goes through the existing content take-down (`AdminContentReviewService.takeDown`:
 * status removed, the creator told, the audit row written). The Hub has no admin removal for a comment, a community
 * message or a chat message, so those are deleted here (a comment also gives its piece's count back). A paid question
 * carries money, so it cannot be removed; asking for it answers 409.
 *
 * USER-SUSPEND (R-121): a report can also end in the person being suspended. `take_down` on a profile suspends the
 * person; `take_down_and_suspend` removes the item and suspends whoever made it; `suspend` suspends and leaves the item
 * (the way to act on a paid question). The suspension is `UserSuspensionService`'s, with the report on its row.
 */
@Injectable()
export class AdminUgcReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wawuId: WawuIdClient,
    private readonly content: AdminContentReviewService,
    private readonly suspensions: UserSuspensionService,
  ) {}

  async list(
    query: AdminUgcReportsQueryDto,
  ): Promise<Paginated<AdminUgcReportView>> {
    const where = {
      status: 'open',
      ...(query.kind ? { kind: query.kind } : {}),
    };
    const groups = await this.prisma.ugcReport.groupBy({
      by: ['kind', 'targetId'],
      where,
      _count: { _all: true },
      _min: { createdAt: true },
      _max: { createdAt: true },
      orderBy: [{ _min: { createdAt: 'asc' } }, { targetId: 'asc' }],
      skip: (query.page - 1) * query.perPage,
      take: query.perPage,
    });
    const totalRows = await this.prisma.ugcReport.groupBy({
      by: ['kind', 'targetId'],
      where,
    });
    if (groups.length === 0) {
      return {
        items: [],
        currentPage: query.page,
        perPage: query.perPage,
        total: totalRows.length,
      };
    }

    const firsts = await this.prisma.ugcReport.findMany({
      where: {
        status: 'open',
        OR: groups.map((g) => ({ kind: g.kind, targetId: g.targetId })),
      },
      orderBy: { createdAt: 'asc' },
    });
    const firstOf = new Map<string, (typeof firsts)[number]>();
    for (const r of firsts) {
      const key = `${r.kind}:${r.targetId}`;
      if (!firstOf.has(key)) firstOf.set(key, r);
    }

    const people = await this.people(
      [...firstOf.values()].flatMap((r) => [r.reporterWawuId, r.subjectWawuId]),
    );
    const suspended = new Set(await suspendedIds(this.prisma));
    const kept = new Set(
      (
        await this.prisma.userProfile.findMany({
          where: {
            wawuUserId: {
              in: [...firstOf.values()].map((r) => r.subjectWawuId),
            },
          },
          select: { wawuUserId: true },
        })
      ).map((p) => p.wawuUserId),
    );
    const items: AdminUgcReportView[] = [];
    for (const g of groups) {
      const r = firstOf.get(`${g.kind}:${g.targetId}`);
      if (!r) continue;
      const kind = r.kind as UgcKind;
      const reason = r.reason as UgcReason;
      items.push({
        id: r.id,
        kind,
        kindLabel: UGC_KIND_LABELS[kind],
        targetId: r.targetId,
        count: g._count._all,
        reason,
        reasonLabel: UGC_REASON_LABELS[reason],
        note: r.note,
        reportedAt: r.createdAt,
        lastReportedAt: g._max.createdAt ?? r.createdAt,
        reporter: people.get(r.reporterWawuId) ?? {
          wawuId: r.reporterWawuId,
          name: '',
          handle: null,
        },
        subject: people.get(r.subjectWawuId) ?? {
          wawuId: r.subjectWawuId,
          name: '',
          handle: null,
        },
        item: await this.itemOf(kind, r.targetId),
        emailed: r.emailedAt !== null,
        canTakeDown: TAKE_DOWN_KINDS.has(kind),
        subjectSuspended: suspended.has(r.subjectWawuId),
        canSuspend:
          kept.has(r.subjectWawuId) && !suspended.has(r.subjectWawuId),
      });
    }
    return {
      items,
      currentPage: query.page,
      perPage: query.perPage,
      total: totalRows.length,
    };
  }

  async resolve(
    id: string,
    dto: ResolveUgcReportDto,
    admin: AdminUserView,
  ): Promise<AdminUgcResolveView> {
    const report = await this.prisma.ugcReport.findUnique({ where: { id } });
    if (!report) throw new NotFoundException('Report not found.');
    const kind = report.kind as UgcKind;
    const note = dto.note?.trim() ? dto.note.trim() : null;

    if (report.status !== 'open') {
      // Already settled (a second click, or another moderator got there first): the answer is the outcome it has.
      return {
        id: report.id,
        kind,
        targetId: report.targetId,
        status: report.status === 'actioned' ? 'actioned' : 'dismissed',
        resolved: 0,
        suspended: await this.suspensions.isSuspended(report.subjectWawuId),
      };
    }

    // What this call does. A profile has no item to remove: `take_down` on it is the suspension (R-121).
    const removes =
      kind !== 'profile' &&
      (dto.action === 'take_down' || dto.action === 'take_down_and_suspend');
    const suspends =
      dto.action === 'suspend' ||
      dto.action === 'take_down_and_suspend' ||
      (dto.action === 'take_down' && kind === 'profile');

    if (removes && !TAKE_DOWN_KINDS.has(kind)) {
      throw new ConflictException(
        'A paid question cannot be taken down. Dismiss the report, or suspend the person.',
      );
    }
    if ((removes || suspends) && !note) {
      throw new ConflictException(
        suspends && !removes
          ? 'A suspension needs a note. It is the only record of why the person was suspended.'
          : 'A take-down needs a note. It is the only record of why the item came down.',
      );
    }
    if (removes) await this.takeDown(kind, report.targetId, note!, admin);

    if (suspends) {
      try {
        await this.suspensions.suspend(
          report.subjectWawuId,
          {
            reason: dto.suspendReason ?? (report.reason as SuspensionReason),
            note: note ?? undefined,
            reportId: report.id,
          },
          admin,
        );
      } catch (e) {
        // The person has deleted their account since: there is nobody left to suspend, and the item is dealt with.
        if (!(e instanceof NotFoundException)) throw e;
      }
    }

    const status = removes || suspends ? 'actioned' : 'dismissed';
    const done = await this.prisma.ugcReport.updateMany({
      where: { kind: report.kind, targetId: report.targetId, status: 'open' },
      data: {
        status,
        resolution: note,
        resolvedAt: new Date(),
        resolvedByAdminId: admin.id,
        resolvedByAdminEmail: admin.email,
        resolvedByAdminRole: admin.role,
      },
    });
    return {
      id: report.id,
      kind,
      targetId: report.targetId,
      status,
      resolved: done.count,
      suspended: await this.suspensions.isSuspended(report.subjectWawuId),
    };
  }

  private async takeDown(
    kind: UgcKind,
    targetId: string,
    note: string,
    admin: AdminUserView,
  ): Promise<void> {
    switch (kind) {
      case 'piece': {
        const piece = await this.prisma.contentPiece.findUnique({
          where: { id: targetId },
          select: { status: true },
        });
        // Already gone (the creator removed it): nothing left to take down.
        if (piece && piece.status !== 'removed')
          await this.content.takeDown(targetId, { reason: note }, admin);
        return;
      }
      case 'comment': {
        const c = await this.prisma.comment.findUnique({
          where: { id: targetId },
          select: { contentId: true },
        });
        if (!c) return;
        await this.prisma.$transaction([
          this.prisma.comment.delete({ where: { id: targetId } }),
          this.prisma.contentPiece.updateMany({
            where: { id: c.contentId, commentCount: { gt: 0 } },
            data: { commentCount: { decrement: 1 } },
          }),
        ]);
        return;
      }
      case 'community_message':
        await this.prisma.communityMessage.deleteMany({
          where: { id: targetId },
        });
        return;
      case 'chat_message': {
        const m = await this.prisma.chatMessage.findUnique({
          where: { id: targetId },
          select: { kind: true },
        });
        if (!m) return;
        if (m.kind === 'money_request') {
          throw new ConflictException(
            'A money request cannot be taken down. Dismiss the report.',
          );
        }
        await this.prisma.chatMessage.deleteMany({ where: { id: targetId } });
        return;
      }
      default:
        return;
    }
  }

  private async people(ids: string[]): Promise<Map<string, AdminUgcPerson>> {
    const unique = [...new Set(ids)];
    const out = new Map<string, AdminUgcPerson>();
    if (unique.length === 0) return out;
    const [identities, profiles] = await Promise.all([
      this.wawuId.lookupPublicIdentities(unique),
      this.prisma.userProfile.findMany({
        where: { wawuUserId: { in: unique } },
        select: { wawuUserId: true, handle: true },
      }),
    ]);
    const handleOf = new Map(profiles.map((p) => [p.wawuUserId, p.handle]));
    for (const id of unique) {
      const who = identities.get(id);
      const name = [who?.firstName, who?.lastName]
        .filter(Boolean)
        .join(' ')
        .trim();
      out.set(id, {
        wawuId: id,
        name: name || handleOf.get(id) || '',
        handle: handleOf.get(id) ?? null,
      });
    }
    return out;
  }

  private async itemOf(
    kind: UgcKind,
    id: string,
  ): Promise<AdminUgcReportView['item']> {
    const gone = { exists: false, title: null, excerpt: null, status: null };
    switch (kind) {
      case 'piece': {
        const p = await this.prisma.contentPiece.findUnique({
          where: { id },
          select: { title: true, description: true, status: true },
        });
        return p
          ? {
              exists: true,
              title: p.title,
              excerpt: cut(p.description),
              status: p.status,
            }
          : gone;
      }
      case 'comment': {
        const c = await this.prisma.comment.findUnique({
          where: { id },
          select: { text: true },
        });
        return c
          ? { exists: true, title: null, excerpt: cut(c.text), status: null }
          : gone;
      }
      case 'profile': {
        const u = await this.prisma.userProfile.findUnique({
          where: { wawuUserId: id },
          select: { handle: true },
        });
        return u
          ? { exists: true, title: u.handle, excerpt: null, status: null }
          : gone;
      }
      case 'community_message': {
        const m = await this.prisma.communityMessage.findUnique({
          where: { id },
          select: { text: true, imageUrl: true, videoUrl: true },
        });
        return m
          ? {
              exists: true,
              title: null,
              excerpt:
                cut(m.text) ??
                (m.imageUrl
                  ? '(photo)'
                  : m.videoUrl
                    ? '(video)'
                    : '(voice note)'),
              status: null,
            }
          : gone;
      }
      case 'chat_message': {
        const m = await this.prisma.chatMessage.findUnique({
          where: { id },
          select: { text: true, kind: true },
        });
        return m
          ? {
              exists: true,
              title: null,
              excerpt: cut(m.text) ?? `(${m.kind})`,
              status: null,
            }
          : gone;
      }
      case 'direct_message': {
        const d = await this.prisma.directMessage.findUnique({
          where: { id },
          select: { text: true },
        });
        return d
          ? { exists: true, title: null, excerpt: cut(d.text), status: null }
          : gone;
      }
    }
  }
}
