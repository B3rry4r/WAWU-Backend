import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { WawuIdClient } from '../common/auth/wawu-id.client';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import type { VerificationSubmission, VerificationLevelEntry } from '../common/types';
import { VERIFICATION_TIER_VALUES, type CreateVerificationSubmissionDto } from './dto/create-verification-submission.dto';
import type { ResubmitVerificationSubmissionDto } from './dto/resubmit-verification-submission.dto';
import type { ReviewVerificationSubmissionDto } from './dto/review-verification-submission.dto';

/**
 * VerificationSubmission resource — registry.json "VerificationSubmission".
 * Owns the submission/review workflow only (documents, reviewer notes,
 * rejection reasons, resubmission). The badge *tier* itself is WAWU ID's own
 * `verificationTier` claim — on approval this service calls
 * WawuIdClient.elevateVerificationTier and never persists tier as this
 * backend's source of truth (conventions.md § Auth model).
 */
@Injectable()
export class VerificationSubmissionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wawuIdClient: WawuIdClient,
  ) {}

  /**
   * GET /verification/ladder — "VerificationLevelEntry[] (derived: JWT
   * verificationTier + submission history)". Not its own table: combines
   * the WAWU-ID-owned current tier with this user's own submission rows.
   */
  async ladder(user: WawuJwtClaims): Promise<VerificationLevelEntry[]> {
    const submissions = await this.prisma.verificationSubmission.findMany({
      where: { wawuUserId: user.sub },
      orderBy: { submittedAt: 'desc' },
    });

    const currentRank = VERIFICATION_TIER_VALUES.indexOf(
      user.verificationTier as (typeof VERIFICATION_TIER_VALUES)[number],
    );

    return VERIFICATION_TIER_VALUES.map((tier, rank) => ({
      tier,
      achieved: currentRank >= rank,
      currentTier: user.verificationTier === tier,
      submission: submissions.find((s) => s.tier === tier) ?? null,
    }));
  }

  /** GET /verification/submissions — the current user's own submission history. */
  async listMine(wawuUserId: string): Promise<VerificationSubmission[]> {
    return this.prisma.verificationSubmission.findMany({
      where: { wawuUserId },
      orderBy: { submittedAt: 'desc' },
    });
  }

  /** POST /verification/submissions. */
  async create(wawuUserId: string, dto: CreateVerificationSubmissionDto): Promise<VerificationSubmission> {
    const existingPending = await this.prisma.verificationSubmission.findFirst({
      where: { wawuUserId, status: 'pending' },
    });
    if (existingPending) {
      throw new BadRequestException('A verification submission is already pending review');
    }

    return this.prisma.verificationSubmission.create({
      data: {
        wawuUserId,
        tier: dto.tier,
        documents: dto.documents,
        status: 'pending',
      },
    });
  }

  private async findOwned(id: string, wawuUserId: string): Promise<VerificationSubmission> {
    const submission = await this.prisma.verificationSubmission.findUnique({ where: { id } });
    if (!submission) {
      throw new NotFoundException('Verification submission not found');
    }
    if (submission.wawuUserId !== wawuUserId) {
      throw new ForbiddenException('You do not own this verification submission');
    }
    return submission;
  }

  /** POST /verification/submissions/:id/resubmit — only a rejected submission can be resubmitted. */
  async resubmit(
    id: string,
    wawuUserId: string,
    dto: ResubmitVerificationSubmissionDto,
  ): Promise<VerificationSubmission> {
    const submission = await this.findOwned(id, wawuUserId);
    if (submission.status !== 'rejected') {
      throw new BadRequestException('Only a rejected submission can be resubmitted');
    }

    return this.prisma.verificationSubmission.update({
      where: { id },
      data: {
        documents: dto.documents,
        status: 'pending',
        reviewedAt: null,
        rejectionReason: null,
        submittedAt: new Date(),
      },
    });
  }

  /**
   * POST /verification/submissions/:id/review — roles: ["admin"] (gated by
   * VerificationAdminGuard at the controller). Only a pending submission can
   * be reviewed. On approval, elevates the tier at WAWU ID.
   */
  async review(id: string, dto: ReviewVerificationSubmissionDto): Promise<VerificationSubmission> {
    const submission = await this.prisma.verificationSubmission.findUnique({ where: { id } });
    if (!submission) {
      throw new NotFoundException('Verification submission not found');
    }
    if (submission.status !== 'pending') {
      throw new BadRequestException('Only a pending submission can be reviewed');
    }
    if (dto.decision === 'rejected' && !dto.rejectionReason) {
      throw new BadRequestException('rejectionReason is required when rejecting a submission');
    }

    // Elevate at WAWU ID BEFORE recording the approval locally.
    //
    // The other order looks harmless but is not recoverable: this method
    // refuses any submission that is not `pending`, so if the row were
    // flipped to `approved` first and the callback then failed, the
    // submission would be permanently approved on this side, never elevated
    // at WAWU ID, and impossible to retry through the API — a silent
    // divergence between two services with no way back. Elevating first
    // means a failed callback leaves the submission `pending` and the review
    // simply retryable. The reverse risk is benign: if the callback succeeds
    // and the write then fails, the tier PATCH is idempotent (it sets an
    // absolute value), so the retry re-sends the same tier.
    if (dto.decision === 'approved') {
      await this.wawuIdClient.elevateVerificationTier(
        submission.wawuUserId,
        submission.tier,
      );
    }

    return this.prisma.verificationSubmission.update({
      where: { id },
      data: {
        status: dto.decision,
        reviewedAt: new Date(),
        rejectionReason:
          dto.decision === 'rejected' ? (dto.rejectionReason ?? null) : null,
      },
    });
  }
}
