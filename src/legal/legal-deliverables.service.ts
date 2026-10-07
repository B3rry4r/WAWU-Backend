import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  AdminOpsAuditService,
  type AdminActor,
} from '../common/audit/admin-ops-audit.service';
import { NotificationService } from '../notification/notification.service';
import type {
  DeliverFilesResultView,
  LegalDeliverableView,
  LegalDeliverablesView,
} from './legal-consultation.types';
import type { DeliverFilesDto } from './dto/legal-consultation.dto';

/**
 * Delivering several files on one legal request (LEGAL-03, S23).
 *
 * Before this a request carried one `deliverableUrl`, so a consultant who sent
 * a reviewed agreement and their notes had to pick one. Now each file is its
 * own row, and each is also posted into the matter's chat as a message from
 * the consultant who sent it, so the client finds every document in the
 * conversation. The first file is still copied to `deliverableUrl`, so the
 * routes that read a single file keep answering.
 */
@Injectable()
export class LegalDeliverablesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminOpsAuditService,
    private readonly notifications: NotificationService,
  ) {}

  /**
   * Operator: deliver files. Allowed on paid work in progress, which it moves
   * to `delivered`, and on work already delivered, where it adds files. A file
   * already delivered on the request is skipped, so sending the same list
   * twice posts it once.
   */
  async deliver(
    admin: AdminActor,
    requestId: string,
    dto: DeliverFilesDto,
  ): Promise<DeliverFilesResultView> {
    const request = await this.prisma.legalRequest.findUnique({
      where: { id: requestId },
    });
    if (!request) throw new NotFoundException('Legal request not found.');
    if (request.status !== 'in_progress' && request.status !== 'delivered') {
      throw new ConflictException(
        `Files can only be delivered on work in progress or delivered work, not a request that is ${request.status}.`,
      );
    }
    if (request.status === 'in_progress' && !request.servicePaidAt) {
      throw new BadRequestException('This work has not been paid for.');
    }

    let posted: { fileName: string; url: string }[] = [];
    try {
      posted = await this.prisma.$transaction(async (tx) => {
        const have = new Set(
          (
            await tx.legalDeliverable.findMany({
              where: { legalRequestId: requestId },
              select: { url: true },
            })
          ).map((d) => d.url),
        );
        const fresh = dto.files.filter((f) => {
          if (have.has(f.url)) return false;
          have.add(f.url);
          return true;
        });

        // One millisecond apart, so the messages keep the order they were
        // sent in whatever sorts them.
        const base = Date.now();
        for (const [i, file] of fresh.entries()) {
          const createdAt = new Date(base + i);
          const message = await tx.legalChatMessage.create({
            data: {
              legalRequestId: requestId,
              authorRole: 'consultant',
              authorAdminId: admin.id,
              body: file.fileName,
              createdAt,
            },
          });
          await tx.legalDeliverable.create({
            data: {
              legalRequestId: requestId,
              wawuUserId: request.wawuUserId,
              fileName: file.fileName,
              url: file.url,
              pages: file.pages ?? null,
              chatMessageId: message.id,
              postedByAdminId: admin.id,
              createdAt,
            },
          });
        }

        if (request.status === 'in_progress') {
          const flipped = await tx.legalRequest.updateMany({
            where: { id: requestId, status: 'in_progress' },
            data: {
              status: 'delivered',
              deliverableUrl: fresh[0]?.url ?? dto.files[0].url,
              deliveredAt: new Date(),
            },
          });
          if (flipped.count === 0) {
            throw new ConflictException('This request has just been delivered.');
          }
        }
        return fresh.map((f) => ({ fileName: f.fileName, url: f.url }));
      });
    } catch (e) {
      // Two deliveries of the same file at the same moment: the unique index
      // keeps one copy, and the loser is told rather than answered with a 500.
      if ((e as { code?: string }).code === 'P2002') {
        throw new ConflictException('Those files were just delivered.');
      }
      throw e;
    }

    if (posted.length > 0) {
      await this.audit.record(admin, {
        resource: 'legal_request',
        resourceId: requestId,
        subjectWawuId: request.wawuUserId,
        action: 'legal_delivered',
        detail: { fileCount: posted.length, files: posted },
      });
      await this.notifications.emit({
        kind: 'legal_delivered',
        userWawuId: request.wawuUserId,
        requestId,
        serviceName: request.serviceName,
        fileCount: posted.length,
      });
    }

    const after = await this.prisma.legalRequest.findUniqueOrThrow({
      where: { id: requestId },
    });
    return {
      requestId,
      status: after.status,
      deliveredAt: after.deliveredAt?.toISOString() ?? null,
      items: await this.items(after),
    };
  }

  /** The client's own delivered files. */
  async list(wawuUserId: string, requestId: string): Promise<LegalDeliverablesView> {
    const request = await this.prisma.legalRequest.findUnique({
      where: { id: requestId },
    });
    if (!request || request.wawuUserId !== wawuUserId) {
      throw new NotFoundException('Legal request not found.');
    }
    return {
      requestId,
      status: request.status,
      items: await this.items(request),
    };
  }

  /**
   * The files of a request, oldest first. A request delivered through the
   * single-file route has no rows, so its one file is read from
   * `deliverableUrl` and has no chat message.
   */
  private async items(request: {
    id: string;
    deliverableUrl: string | null;
    deliveredAt: Date | null;
  }): Promise<LegalDeliverableView[]> {
    const rows = await this.prisma.legalDeliverable.findMany({
      where: { legalRequestId: request.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    if (rows.length > 0) {
      return rows.map((r) => ({
        id: r.id,
        fileName: r.fileName,
        url: r.url,
        pages: r.pages,
        chatMessageId: r.chatMessageId,
        postedAt: r.createdAt.toISOString(),
      }));
    }
    if (request.deliverableUrl) {
      return [
        {
          id: `${request.id}:deliverable`,
          fileName: fileNameFromUrl(request.deliverableUrl),
          url: request.deliverableUrl,
          pages: null,
          chatMessageId: null,
          postedAt: (request.deliveredAt ?? new Date(0)).toISOString(),
        },
      ];
    }
    return [];
  }
}

/** The last path segment of a link, decoded, for a file delivered without a name. */
export function fileNameFromUrl(url: string): string {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    const name = last ? decodeURIComponent(last) : '';
    return name || 'Document';
  } catch {
    return 'Document';
  }
}
