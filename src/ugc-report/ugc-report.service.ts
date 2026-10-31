import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import type { CreateUgcReportDto } from './dto/create-ugc-report.dto';
import { UgcReportMailService } from './ugc-report-mail.service';
import type { UgcKind, UgcReason, UgcStatus } from './ugc-report.kinds';

/** What a report answers. A repeat answers the first report with `alreadyReported: true`. */
export interface UgcReportView {
  id: string;
  kind: UgcKind;
  targetId: string;
  reason: UgcReason;
  status: UgcStatus;
  createdAt: Date;
  alreadyReported: boolean;
}

/** New reports one person may file in an hour. Each one is mailed to support, so a flood must not reach the mailbox. */
export const UGC_REPORTS_PER_HOUR = 30;

export interface ReportTarget {
  /** The person who made the thing; for a profile, the person. */
  subject: string;
  /** A short piece of the thing, for the support mail. */
  preview: string;
}

const cut = (text: string | null | undefined, max = 160): string => {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/**
 * REPORT-UGC: one route, `POST /reports`, for a piece, a comment, a profile, a community message, a chat message and a
 * paid question. It reuses the paid-question report's idea (one report per person per item) in one table, "UgcReport".
 *
 * - The reporter must be able to see the thing: a member of the room for a community message, one of the two people for
 *   a chat message or a paid question. A thing that does not exist, or that the reporter may not see, answers 404.
 * - Nobody reports their own thing (400).
 * - A repeat answers the same report with 200 and `alreadyReported: true`; no second row, no second mail.
 * - A paid question also writes the paid-question report's own row (DmReport), so what `POST /dm/:id/report` kept stays
 *   whole whichever route the app calls.
 */
@Injectable()
export class UgcReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: UgcReportMailService,
  ) {}

  async create(
    reporter: string,
    dto: CreateUgcReportDto,
  ): Promise<UgcReportView> {
    const earlier = await this.find(reporter, dto.kind, dto.targetId);
    if (earlier) return this.view(earlier, true);

    const recent = await this.prisma.ugcReport.count({
      where: {
        reporterWawuId: reporter,
        createdAt: { gt: new Date(Date.now() - 3_600_000) },
      },
    });
    if (recent >= UGC_REPORTS_PER_HOUR) {
      throw new HttpException(
        'You have sent a lot of reports. Try again in a little while.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const target = await this.resolve(reporter, dto.kind, dto.targetId);
    if (target.subject === reporter) {
      throw new BadRequestException(
        dto.kind === 'profile'
          ? 'You cannot report yourself.'
          : 'You cannot report your own post.',
      );
    }

    let row;
    try {
      row = await this.prisma.ugcReport.create({
        data: {
          kind: dto.kind,
          targetId: dto.targetId,
          subjectWawuId: target.subject,
          reporterWawuId: reporter,
          reason: dto.reason,
          note: dto.note?.trim() ? dto.note.trim() : null,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        // Two taps at once: the other one won. Answer with its report.
        const raced = await this.find(reporter, dto.kind, dto.targetId);
        if (raced) return this.view(raced, true);
      }
      throw error;
    }

    if (dto.kind === 'direct_message') {
      await this.prisma.dmReport.upsert({
        where: {
          threadId_reporterWawuId: {
            threadId: dto.targetId,
            reporterWawuId: reporter,
          },
        },
        update: {},
        create: { threadId: dto.targetId, reporterWawuId: reporter },
      });
    }

    this.mail.notify({
      id: row.id,
      kind: dto.kind,
      targetId: dto.targetId,
      reason: dto.reason,
      note: row.note,
      reporterWawuId: reporter,
      subjectWawuId: target.subject,
      preview: target.preview,
    });
    return this.view(row, false);
  }

  private find(reporter: string, kind: string, targetId: string) {
    return this.prisma.ugcReport.findUnique({
      where: {
        reporterWawuId_kind_targetId: {
          reporterWawuId: reporter,
          kind,
          targetId,
        },
      },
    });
  }

  private view(
    row: {
      id: string;
      kind: string;
      targetId: string;
      reason: string;
      status: string;
      createdAt: Date;
    },
    alreadyReported: boolean,
  ): UgcReportView {
    return {
      id: row.id,
      kind: row.kind as UgcKind,
      targetId: row.targetId,
      reason: row.reason as UgcReason,
      status: row.status as UgcStatus,
      createdAt: row.createdAt,
      alreadyReported,
    };
  }

  /** Finds the thing, checks the reporter may see it, and says whose it is. */
  async resolve(
    reporter: string,
    kind: UgcKind,
    id: string,
  ): Promise<ReportTarget> {
    switch (kind) {
      case 'piece': {
        const p = await this.prisma.contentPiece.findUnique({
          where: { id },
          select: { creatorWawuId: true, status: true, title: true },
        });
        if (!p || p.status === 'removed')
          throw new NotFoundException('That piece is not available.');
        return { subject: p.creatorWawuId, preview: cut(p.title) };
      }
      case 'comment': {
        const c = await this.prisma.comment.findUnique({
          where: { id },
          select: { authorWawuId: true, text: true },
        });
        if (!c) throw new NotFoundException('That comment is not available.');
        return { subject: c.authorWawuId, preview: cut(c.text) };
      }
      case 'profile': {
        const u = await this.prisma.userProfile.findUnique({
          where: { wawuUserId: id },
          select: { wawuUserId: true, handle: true },
        });
        if (!u) throw new NotFoundException('That profile is not available.');
        return { subject: u.wawuUserId, preview: cut(u.handle) };
      }
      case 'community_message': {
        const m = await this.prisma.communityMessage.findUnique({
          where: { id },
          select: {
            senderWawuId: true,
            text: true,
            imageUrl: true,
            videoUrl: true,
            communityId: true,
            community: { select: { hostWawuId: true } },
          },
        });
        if (!m) throw new NotFoundException('That message is not available.');
        if (reporter !== m.community.hostWawuId) {
          const member = await this.prisma.communityMembership.findFirst({
            where: {
              communityId: m.communityId,
              userWawuId: reporter,
              status: 'joined',
            },
            select: { id: true },
          });
          if (!member)
            throw new NotFoundException('That message is not available.');
        }
        const kindWord = m.imageUrl
          ? '(photo)'
          : m.videoUrl
            ? '(video)'
            : '(voice note)';
        return { subject: m.senderWawuId, preview: cut(m.text) || kindWord };
      }
      case 'chat_message': {
        const m = await this.prisma.chatMessage.findUnique({
          where: { id },
          select: {
            senderWawuId: true,
            kind: true,
            text: true,
            conversation: { select: { userAWawuId: true, userBWawuId: true } },
          },
        });
        if (
          !m ||
          (m.conversation.userAWawuId !== reporter &&
            m.conversation.userBWawuId !== reporter)
        ) {
          throw new NotFoundException('That message is not available.');
        }
        return {
          subject: m.senderWawuId,
          preview: cut(m.text) || `(${m.kind})`,
        };
      }
      case 'direct_message': {
        const d = await this.prisma.directMessage.findUnique({
          where: { id },
          select: { senderWawuId: true, creatorWawuId: true, text: true },
        });
        if (!d)
          throw new NotFoundException('That conversation is not available.');
        if (d.senderWawuId !== reporter && d.creatorWawuId !== reporter) {
          throw new ForbiddenException(
            'You can only report a conversation you are in.',
          );
        }
        return {
          subject:
            d.senderWawuId === reporter ? d.creatorWawuId : d.senderWawuId,
          preview: cut(d.text),
        };
      }
    }
  }
}
