import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { type AdminActor } from '../common/audit/admin-ops-audit.service';
import { LegalAssistantAllowance } from '../legal-intake/assistant/legal-assistant-allowance';
import { NotificationService } from '../notification/notification.service';
import {
  StorageService,
  deliverableKeyFrom,
  type BucketLocation,
} from '../storage/storage.service';
import {
  DELIVERY_REFUSAL_MESSAGE,
  LegalDeliveryRule,
} from './legal-delivery-rule';
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
    private readonly notifications: NotificationService,
    private readonly allowance: LegalAssistantAllowance,
    private readonly storage: StorageService,
    private readonly rule: LegalDeliveryRule,
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

    // N1 and FIX-24: a delivered file can only be a legal document on our
    // own bucket (a bare key, or a link on this bucket's host, under
    // DELIVERABLE_KEY_FOLDERS) that someone uploaded through WAWU, and that
    // upload must be this client's own or the legal team's. Anything else is
    // refused before anything is written, so no other object, and no other
    // client's document, can become this client's link.
    const at = await this.rule.location();
    const checks = await this.rule.check(
      request.wawuUserId,
      dto.files.map((f) => f.url),
      at,
    );
    const refused = checks.findIndex((c) => c.key === null);
    if (refused !== -1) {
      throw new BadRequestException([
        `files.${refused}.url ${DELIVERY_REFUSAL_MESSAGE}`,
      ]);
    }
    const keys = checks.map((c) => c.key as string);
    // The single-file column the web reads holds a link, as it always has
    // (E3, unchanged here); a bare key is given one.
    const firstLink = async (i: number): Promise<string> =>
      /^https?:\/\//i.test(dto.files[i].url)
        ? dto.files[i].url
        : this.storage.readUrlFor(keys[i]);

    let posted: { fileName: string; url: string }[] = [];
    try {
      // Under the client's lock (LEGAL-01), so each handover to the consultant
      // is ordered against the client's own messages. The files, the chat
      // lines, the status change and the audit row are one transaction: all of
      // it happens, or none of it, and the client is told only after.
      posted = await this.allowance.writeAsConsultant(
        request.wawuUserId,
        async (tx, lockedAt) => {
          const have = new Set(
            (
              await tx.legalDeliverable.findMany({
                where: { legalRequestId: requestId },
                select: { url: true },
              })
            ).map((d) => deliverableKeyFrom(d.url, at) ?? d.url),
          );
          const fresh = dto.files
            .map((f, i) => ({ ...f, key: keys[i], index: i }))
            .filter((f) => {
              if (have.has(f.key)) return false;
              have.add(f.key);
              return true;
            });

          // One millisecond apart, so the messages keep the order they were
          // sent in whatever sorts them.
          const base = lockedAt.getTime();
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
                // The object key, never the signed link ops posted: a link
                // dies in 7 days and is a bearer token. The list signs a
                // fresh 15-minute link for the owner on every read.
                url: file.key,
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
                deliverableUrl: await firstLink(fresh[0]?.index ?? 0),
                deliveredAt: new Date(),
              },
            });
            if (flipped.count === 0) {
              throw new ConflictException(
                'This request has just been delivered.',
              );
            }
          }
          const files = fresh.map((f) => ({
            fileName: f.fileName,
            url: f.key,
          }));
          if (files.length > 0) {
            await tx.adminOpsAudit.create({
              data: {
                resource: 'legal_request',
                resourceId: requestId,
                subjectWawuId: request.wawuUserId,
                action: 'legal_delivered',
                detail: { fileCount: files.length, files },
                actedByAdminId: admin.id,
                actedByAdminEmail: admin.email,
                actedByAdminRole: admin.role,
              },
            });
          }
          return files;
        },
      );
    } catch (e) {
      // Two deliveries of the same file at the same moment: the unique index
      // keeps one copy, and the loser is told rather than answered with a 500.
      if ((e as { code?: string }).code === 'P2002') {
        throw new ConflictException('Those files were just delivered.');
      }
      throw e;
    }

    if (posted.length > 0) {
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
      items: await this.items(after, at),
    };
  }

  /** The client's own delivered files. */
  async list(
    wawuUserId: string,
    requestId: string,
  ): Promise<LegalDeliverablesView> {
    const request = await this.prisma.legalRequest.findUnique({
      where: { id: requestId },
    });
    if (!request || request.wawuUserId !== wawuUserId) {
      throw new NotFoundException('Legal request not found.');
    }
    return {
      requestId,
      status: request.status,
      items: await this.items(request, await this.rule.location()),
    };
  }

  /**
   * The files of a request, oldest first. A file delivered through the
   * single-file route has no row and no chat message, so it is read from
   * `deliverableUrl` and listed first, unless a row already carries it. That
   * keeps it listed when more files are added to the same request later.
   *
   * Each gets a fresh read link, valid 15 minutes, only when it passes the
   * delivery rule for this request's owner (N1 and FIX-24): a key on this
   * bucket under DELIVERABLE_KEY_FOLDERS, uploaded through WAWU by the owner
   * or by the legal team. A row that still holds a signed link from before
   * has its key read from it here. Anything else (a key in another folder, a
   * link to another host, another client's document, a key nobody uploaded,
   * a legacy `deliverableUrl` included) is listed by name with no link, is
   * logged once, and is never signed or handed back as it was stored.
   */
  private async items(
    request: {
      id: string;
      wawuUserId: string;
      deliverableUrl: string | null;
      deliveredAt: Date | null;
    },
    at: BucketLocation | null,
  ): Promise<LegalDeliverableView[]> {
    const rows = await this.prisma.legalDeliverable.findMany({
      where: { legalRequestId: request.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const legacy = request.deliverableUrl;
    const keyOf = (v: string) => deliverableKeyFrom(v, at) ?? v;
    const withLegacy =
      legacy !== null &&
      legacy !== '' &&
      !rows.some((r) => keyOf(r.url) === keyOf(legacy));
    const checks = await this.rule.check(
      request.wawuUserId,
      [...rows.map((r) => r.url), ...(withLegacy ? [legacy] : [])],
      at,
    );
    // Called only after the ownership check (or for the operator's own
    // answer): a link is signed for the reader the API has already accepted.
    const linkFor = async (
      i: number,
      fileId: string,
    ): Promise<string | null> => {
      const check = checks[i];
      if (check.key === null) {
        this.rule.withheld(request.id, fileId, check.refusal);
        return null;
      }
      return this.storage.signedReadUrl(check.key, DELIVERABLE_LINK_SECONDS);
    };
    const items: LegalDeliverableView[] = await Promise.all(
      rows.map(async (r, i) => ({
        id: r.id,
        fileName: r.fileName,
        url: await linkFor(i, r.id),
        pages: r.pages,
        chatMessageId: r.chatMessageId,
        postedAt: r.createdAt.toISOString(),
      })),
    );
    if (withLegacy) {
      const id = `${request.id}:deliverable`;
      items.unshift({
        id,
        fileName: fileNameFromUrl(legacy),
        url: await linkFor(rows.length, id),
        pages: null,
        chatMessageId: null,
        postedAt: (request.deliveredAt ?? new Date(0)).toISOString(),
      });
    }
    return items;
  }
}

/** How long a delivered file's link lives. */
export const DELIVERABLE_LINK_SECONDS = 900;

/** The last path segment of a link, decoded, for a file delivered without a name. */
export function fileNameFromUrl(url: string): string {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    const name = last ? decodeURIComponent(last) : '';
    // eslint-disable-next-line no-control-regex -- a name with a NUL or control is not a name
    return name && !/[\u0000-\u001f\u007f]/.test(name) ? name : 'Document';
  } catch {
    return 'Document';
  }
}
