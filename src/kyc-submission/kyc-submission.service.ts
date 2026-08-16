import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import type { KycSubmission } from '../common/types';
import type { CreateKycSubmissionDto } from './dto/create-kyc-submission.dto';
import type { ReviewKycSubmissionDto } from './dto/review-kyc-submission.dto';

/**
 * KycSubmission resource — registry.json "KycSubmission". Fully owned by
 * this backend (conventions.md § Auth model: "Creator KYC ... is fully
 * owned by this backend, NOT WAWU ID ... never collapse the two [with
 * verification tier]"). No WawuIdClient involvement anywhere in this
 * service, unlike VerificationSubmission.
 *
 * Both gates from CLAUDE.md are independent: this resource is the manual
 * review workflow that flips CreatorState.kycStatus (the "canEarn" gate).
 * subscriptionPaid (the "canUpload" gate) is untouched by anything here.
 */
@Injectable()
export class KycSubmissionService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Creator gate: same pattern as CreatorStateService (a plain user has no
   * CreatorState row at all) — 403, not 404, since the resource concept
   * exists but this account isn't entitled to it. registry.json roles for
   * both GET /kyc and POST /kyc are ["creator"].
   */
  private async requireCreator(wawuUserId: string): Promise<void> {
    const state = await this.prisma.creatorState.findUnique({ where: { wawuUserId } });
    if (!state) {
      throw new ForbiddenException('This account has no creator state — a creator account type is required.');
    }
  }

  /** GET /kyc — "KycSubmission | null": the caller's most recent submission, or null if none exists. */
  async getMine(wawuUserId: string): Promise<KycSubmission | null> {
    await this.requireCreator(wawuUserId);
    return this.prisma.kycSubmission.findFirst({
      where: { wawuUserId },
      orderBy: { submittedAt: 'desc' },
    });
  }

  /**
   * POST /kyc. Blocks a second submission while one is pending or already
   * approved (mirrors VerificationSubmission's "already pending" guard); a
   * rejected submission can be resubmitted through this same endpoint —
   * registry.json defines no separate /kyc/:id/resubmit route for this
   * resource, unlike VerificationSubmission. On success, sets
   * CreatorState.kycStatus back to "pending" per the registry note ("Sets
   * CreatorState.kycStatus=pending").
   */
  async submit(wawuUserId: string, dto: CreateKycSubmissionDto): Promise<KycSubmission> {
    await this.requireCreator(wawuUserId);

    const latest = await this.prisma.kycSubmission.findFirst({
      where: { wawuUserId },
      orderBy: { submittedAt: 'desc' },
    });
    if (latest?.status === 'pending') {
      throw new BadRequestException('A KYC submission is already pending review');
    }
    if (latest?.status === 'approved') {
      throw new BadRequestException('KYC is already approved for this account');
    }

    const created = await this.prisma.kycSubmission.create({
      data: {
        wawuUserId,
        country: dto.country,
        bvn: dto.bvn ?? null,
        nin: dto.nin ?? null,
        nationalIdEquivalent: dto.nationalIdEquivalent ?? null,
        idDocumentType: dto.idDocumentType,
        idDocumentUrl: dto.idDocumentUrl,
        payoutBankName: dto.payoutBankName,
        payoutAccountNumber: dto.payoutAccountNumber,
        status: 'pending',
      },
    });

    await this.prisma.creatorState.update({
      where: { wawuUserId },
      data: { kycStatus: 'pending' },
    });

    return created;
  }

  /**
   * POST /kyc/:id/review — roles: ["admin"] (gated by KycAdminGuard at the
   * controller). "Manual review only — no automated approval path exists
   * anywhere" (registry note). Only a pending submission can be reviewed.
   * Flips CreatorState.kycStatus to the decision on both approval and
   * rejection, since kycStatus is a live reflection of the latest review
   * outcome, not just a "has been approved at least once" flag.
   */
  async review(id: string, dto: ReviewKycSubmissionDto): Promise<KycSubmission> {
    const submission = await this.prisma.kycSubmission.findUnique({ where: { id } });
    if (!submission) {
      throw new NotFoundException('KYC submission not found');
    }
    if (submission.status !== 'pending') {
      throw new BadRequestException('Only a pending KYC submission can be reviewed');
    }
    if (dto.decision === 'rejected' && !dto.rejectionReason) {
      throw new BadRequestException('rejectionReason is required when rejecting a submission');
    }

    const updated = await this.prisma.kycSubmission.update({
      where: { id },
      data: {
        status: dto.decision,
        reviewedAt: new Date(),
        rejectionReason: dto.decision === 'rejected' ? (dto.rejectionReason ?? null) : null,
      },
    });

    await this.prisma.creatorState.update({
      where: { wawuUserId: submission.wawuUserId },
      data: { kycStatus: dto.decision },
    });

    return updated;
  }
}
