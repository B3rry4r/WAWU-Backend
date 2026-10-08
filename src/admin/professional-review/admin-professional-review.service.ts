import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuIdClient } from '../../common/auth/wawu-id.client';
import { StorageService } from '../../storage/storage.service';
import { isRegulatedCategory } from '../../professional/professional-categories';
import type { ReviewStatus } from '../../../generated/prisma/enums';
import type { AdminProfessionalQueueQueryDto } from './dto/professional-review.dto';
import type { AdminActor } from '../../common/audit/admin-ops-audit.service';
import {
  LISTING_NOT_TAKEN_DOWN,
  lockListing,
  standingTakedown,
} from '../../professional/professional-takedown';
import type { Paginated } from '../../common/interceptors/response.interceptor';
import type {
  AdminProfessionalDecisionView,
  AdminProfessionalDetailView,
  AdminProfessionalDocumentUrlView,
  AdminProfessionalQueueItemView,
} from './admin-professional-view.type';

/**
 * Reviewing professional applications.
 *
 * Approving one puts a person in front of buyers as a qualified practitioner,
 * and in four categories that claim can be relied on for legal, medical or
 * financial decisions. So this surface is built to make the reviewer's actual
 * job possible rather than to make the queue go down:
 *
 *  - Every row says whether its category is REGULATED, and carries the
 *    licence number and issuing body when it is, because "ring the issuing
 *    body and confirm this number" is the job in those four.
 *  - Documents come back as short-lived signed URLs, generated per request.
 *  - A rejection needs a reason the applicant can act on.
 *
 * Approving also elevates the person's verification tier at WAWU ID, which is
 * what puts the badge on their profile everywhere else in the product.
 */
@Injectable()
export class AdminProfessionalReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wawuId: WawuIdClient,
    private readonly storage: StorageService,
  ) {}

  /**
   * Narrow a stored row to what a decision may return.
   *
   * Declaring the return type is NOT enough on its own: `prisma.update`
   * resolves to the full row, TypeScript accepts a wider object where a
   * narrower one is declared, and the extra columns — the licence number
   * among them — go out over the wire regardless. Hazard H-1 in one line.
   * So the object is built by hand.
   */
  private toDecision(row: {
    id: string;
    status: ReviewStatus;
    rejectionReason: string | null;
    reviewedAt: Date | null;
    listed: boolean;
  }): AdminProfessionalDecisionView {
    return {
      id: row.id,
      status: row.status,
      rejectionReason: row.rejectionReason,
      reviewedAt: row.reviewedAt,
      listed: row.listed,
    };
  }

  async queue(
    query: AdminProfessionalQueueQueryDto,
  ): Promise<Paginated<AdminProfessionalQueueItemView>> {
    const status = query.status ?? 'pending';
    const page = query.page ?? 1;
    const perPage = query.perPage ?? 20;
    const where = {
      status,
      ...(query.category ? { category: query.category } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.professionalProfile.findMany({
        where,
        // Longest wait first. An applicant is blocked from earning in this
        // category until someone looks, so age is the queue's real priority.
        orderBy: { submittedAt: 'asc' },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.professionalProfile.count({ where }),
    ]);

    if (rows.length === 0) {
      return { items: [], currentPage: page, perPage, total };
    }

    const identities = await this.wawuId.lookupPublicIdentities(
      rows.map((r) => r.wawuUserId),
    );
    const now = Date.now();

    return {
      items: rows.map((r) => {
        const identity = identities.get(r.wawuUserId);
        const name = [identity?.firstName, identity?.lastName]
          .filter(Boolean)
          .join(' ')
          .trim();
        return {
          id: r.id,
          wawuId: r.wawuUserId,
          name: name || r.wawuUserId,
          category: r.category,
          /** Drives the "confirm the licence" instruction in the UI. */
          regulated: isRegulatedCategory(r.category),
          headline: r.headline,
          credentialKind: r.credentialKind,
          licenceNumber: r.licenceNumber,
          issuingBody: r.issuingBody,
          documentCount: r.documents.length,
          status: r.status,
          submittedAt: r.submittedAt,
          waitingHours: Math.max(
            0,
            Math.round((now - r.submittedAt.getTime()) / 3_600_000),
          ),
        };
      }),
      currentPage: page,
      perPage,
      total,
    };
  }

  /** One application in full, with the evidence a decision rests on. */
  async detail(id: string): Promise<AdminProfessionalDetailView> {
    const row = await this.prisma.professionalProfile.findUnique({
      where: { id },
    });
    if (!row) throw new NotFoundException('Application not found');

    const [identities, profile, otherCategories] = await Promise.all([
      this.wawuId.lookupPublicIdentities([row.wawuUserId]),
      this.prisma.userProfile.findUnique({
        where: { wawuUserId: row.wawuUserId },
        select: { handle: true, bio: true, accountType: true },
      }),
      // What else this person is already approved for. A reviewer seeing a
      // fifth unrelated speciality from the same applicant should be able to
      // notice that without going and looking for it.
      this.prisma.professionalProfile.findMany({
        where: { wawuUserId: row.wawuUserId, id: { not: id } },
        select: { category: true, status: true },
      }),
    ]);

    const identity = identities.get(row.wawuUserId);
    const name = [identity?.firstName, identity?.lastName]
      .filter(Boolean)
      .join(' ')
      .trim();

    return {
      id: row.id,
      wawuId: row.wawuUserId,
      name: name || profile?.handle || row.wawuUserId,
      handle: profile?.handle ?? null,
      bio: profile?.bio ?? null,
      accountType: profile?.accountType ?? null,
      currentVerification: identity?.verificationTier ?? 'basic',
      category: row.category,
      regulated: isRegulatedCategory(row.category),
      headline: row.headline,
      about: row.about,
      services: row.services,
      credentialKind: row.credentialKind,
      licenceNumber: row.licenceNumber,
      issuingBody: row.issuingBody,
      documents: row.documents,
      status: row.status,
      rejectionReason: row.rejectionReason,
      submittedAt: row.submittedAt,
      reviewedAt: row.reviewedAt,
      otherCategories,
    };
  }

  /**
   * A short-lived signed URL for one uploaded document.
   *
   * Minted per request rather than embedded in the detail payload, so a
   * reviewer's browser history, or a screenshot of the queue, does not carry
   * a working link to someone's practising certificate.
   */
  async documentUrl(
    id: string,
    documentUrl: string,
  ): Promise<AdminProfessionalDocumentUrlView> {
    const row = await this.prisma.professionalProfile.findUnique({
      where: { id },
      select: { documents: true },
    });
    if (!row) throw new NotFoundException('Application not found');
    // Only a document belonging to THIS application. Without this check the
    // endpoint signs any object key an admin cares to name.
    if (!row.documents.includes(documentUrl)) {
      throw new NotFoundException('That document is not on this application');
    }
    return { url: await this.storage.signedReadUrl(documentUrl) };
  }

  /**
   * Approve, and elevate the badge at WAWU ID.
   *
   * WAWU ID FIRST, then the local write — the same ordering
   * VerificationSubmissionService documents. If the elevate fails we have not
   * yet told anyone they are approved, and the row stays in the queue to be
   * tried again. Reversed, an approved listing would exist with no badge
   * behind it and nothing to detect the mismatch.
   */
  async approve(id: string): Promise<AdminProfessionalDecisionView> {
    const row = await this.prisma.professionalProfile.findUnique({
      where: { id },
      select: { id: true, status: true, wawuUserId: true },
    });
    if (!row) throw new NotFoundException('Application not found');
    if (row.status !== 'pending') {
      throw new ConflictException(`This application is already ${row.status}.`);
    }

    await this.wawuId.elevateVerificationTier(
      row.wawuUserId,
      'certified_professional',
    );

    return this.toDecision(
      await this.prisma.professionalProfile.update({
        where: { id },
        data: {
          status: 'approved',
          reviewedAt: new Date(),
          rejectionReason: null,
          listed: true,
        },
      }),
    );
  }

  /**
   * Reject with a reason the applicant can act on.
   *
   * No WAWU ID call: a rejection here says nothing about the ladder rung they
   * may already hold from another category, and silently downgrading someone
   * because one application in one field did not stand up would be wrong.
   */
  async reject(
    id: string,
    reason: string,
  ): Promise<AdminProfessionalDecisionView> {
    const row = await this.prisma.professionalProfile.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!row) throw new NotFoundException('Application not found');
    if (row.status !== 'pending') {
      throw new ConflictException(`This application is already ${row.status}.`);
    }

    return this.toDecision(
      await this.prisma.professionalProfile.update({
        where: { id },
        data: {
          status: 'rejected',
          rejectionReason: reason,
          reviewedAt: new Date(),
          listed: false,
        },
      }),
    );
  }

  /**
   * Pull an approved listing out of the directory.
   *
   * Deliberately NOT a delete and NOT a status change: the approval happened
   * and the record of it should survive. This is the control for a complaint
   * that needs acting on before it can be investigated properly.
   *
   * FIX-06: the pull now HOLDS. It records a ProfessionalTakedown (who, when,
   * and what the person had chosen themselves), so the person's Show is
   * refused until an admin lists it again (`relist`). The answer is the one
   * this route always gave (the dashboard reads it). Unlisting a listing that
   * is already taken down changes nothing: the first takedown stands.
   */
  async unlist(
    id: string,
    admin: AdminActor,
  ): Promise<AdminProfessionalDecisionView> {
    return this.prisma.$transaction(async (tx) => {
      if (!(await lockListing(tx, id))) {
        throw new NotFoundException('Application not found');
      }
      const row = await tx.professionalProfile.findUnique({
        where: { id },
        select: { status: true, wawuUserId: true, listed: true },
      });
      if (!row) throw new NotFoundException('Application not found');
      if (row.status !== 'approved') {
        throw new ConflictException(
          'Only an approved listing can be pulled from the directory.',
        );
      }

      if (!(await standingTakedown(tx, id))) {
        const takedown = {
          wawuUserId: row.wawuUserId,
          // The person's own choice as it stands now, put back on relist.
          ownerListed: row.listed,
          takenDownAt: new Date(),
          takenDownByAdminId: admin.id,
          takenDownByAdminEmail: admin.email,
          takenDownByAdminRole: admin.role,
          liftedAt: null,
          liftedByAdminId: null,
          liftedByAdminEmail: null,
          liftedByAdminRole: null,
        };
        await tx.professionalTakedown.upsert({
          where: { professionalId: id },
          create: { professionalId: id, ...takedown },
          update: takedown,
        });
      }

      return this.toDecision(
        await tx.professionalProfile.update({
          where: { id },
          data: { listed: false },
        }),
      );
    });
  }

  /**
   * List again a listing an admin took down (FIX-06): lifts the takedown,
   * records who lifted it and when, and puts the listing back to what its
   * owner had chosen (listed, unless they pressed Hide before or during the
   * takedown). From then on the owner hides and shows it as before.
   *
   * Refused (409, reason.code `listing_not_taken_down`) when no takedown
   * stands: a listing its owner hid is theirs to show, not an admin's.
   */
  async relist(
    id: string,
    admin: AdminActor,
  ): Promise<AdminProfessionalDecisionView> {
    return this.prisma.$transaction(async (tx) => {
      if (!(await lockListing(tx, id))) {
        throw new NotFoundException('Application not found');
      }
      const takedown = await standingTakedown(tx, id);
      if (!takedown) {
        throw new ConflictException({
          message:
            'This listing was not taken down by an admin, so there is nothing to lift. Its owner shows or hides it.',
          reason: { code: LISTING_NOT_TAKEN_DOWN },
        });
      }
      await tx.professionalTakedown.update({
        where: { professionalId: id },
        data: {
          liftedAt: new Date(),
          liftedByAdminId: admin.id,
          liftedByAdminEmail: admin.email,
          liftedByAdminRole: admin.role,
        },
      });
      return this.toDecision(
        await tx.professionalProfile.update({
          where: { id },
          data: { listed: takedown.ownerListed },
        }),
      );
    });
  }
}
