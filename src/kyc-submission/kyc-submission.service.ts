import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { NotificationService } from '../notification/notification.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { StorageService } from '../storage/storage.service';

/** Keeps the last four characters, masks the rest: "22123456789" -> "•••••••6789". */
function maskTail<T extends string | null | undefined>(value: T): T {
  if (!value || value.length <= 4) return value;
  return `${'•'.repeat(value.length - 4)}${value.slice(-4)}` as T;
}
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Creator gate: same pattern as CreatorStateService (a plain user has no
   * CreatorState row at all) — 403, not 404, since the resource concept
   * exists but this account isn't entitled to it. registry.json roles for
   * both GET /kyc and POST /kyc are ["creator"].
   */
  private async requireCreator(wawuUserId: string): Promise<void> {
    // Gate on ACCOUNT TYPE, not on the CreatorState row.
    //
    // CreatorState is only written when a subscription is paid for, so keying
    // on it here refused every creator who had signed up and not yet paid —
    // which is every new creator. The verification screen showed "Could not
    // load your verification status" with a Try again button that could never
    // work, and KYC is the gate on getting PAID, so it is the last thing that
    // should be unreachable before somebody has spent anything.
    //
    // Same fix as CreatorStateService.getState. A plain user is still refused;
    // an unpaid creator is not.
    const profile = await this.prisma.userProfile.findUnique({
      where: { wawuUserId },
      select: { accountType: true },
    });
    if (profile?.accountType !== 'creator') {
      throw new ForbiddenException('This account has no creator state — a creator account type is required.');
    }
  }

  /** GET /kyc — "KycSubmission | null": the caller's most recent submission, or null if none exists. */
  async getMine(wawuUserId: string): Promise<KycSubmission | null> {
    await this.requireCreator(wawuUserId);
    const row = await this.prisma.kycSubmission.findFirst({
      where: { wawuUserId },
      orderBy: { submittedAt: 'desc' },
    });
    return row ? this.maskIdentifiers(await this.withSignedDocument(row)) : null;
  }

  /**
   * Never return full BVN, NIN or bank account numbers on a read.
   *
   * The submitter already knows their own numbers, so echoing them back adds
   * nothing — but tokens live in browser storage, so any XSS on the client
   * turned this endpoint into a full identity + bank-details dump. The UI only
   * ever renders these masked anyway. The stored values are untouched; this
   * masks the response.
   */
  private maskIdentifiers(row: KycSubmission): KycSubmission {
    return {
      ...row,
      bvn: maskTail(row.bvn),
      nin: maskTail(row.nin),
      nationalIdEquivalent: maskTail(row.nationalIdEquivalent),
      payoutAccountNumber: maskTail(row.payoutAccountNumber),
    };
  }

  /**
   * `idDocumentUrl` is stored as a bare object KEY, never as a signed URL —
   * a persisted long-lived URL is a bearer token for a government ID. It is
   * exchanged for a short-lived signed URL only when handed to someone
   * entitled to see it (the owner, or an admin reviewer).
   */
  private async withSignedDocument(row: KycSubmission): Promise<KycSubmission> {
    if (!row.idDocumentUrl) return row;
    try {
      return { ...row, idDocumentUrl: await this.storage.signedReadUrl(row.idDocumentUrl) };
    } catch {
      // Storage unavailable: return the row without a resolvable document
      // rather than failing the whole KYC read.
      return { ...row, idDocumentUrl: '' };
    }
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

    // TELL THE CREATOR. This is the whole point of the review from their side:
    // KYC is the gate on being PAID, so the person waiting on it has the
    // strongest reason on the platform to expect to hear back — and the KYC
    // screen promises "we will notify you".
    //
    // Until now nothing emitted this. The kind was declared, the web client
    // rendered it, and `grep "kind: 'kyc_verified'"` returned zero writers:
    // a creator was approved and never told. Found by the unbacked_promises
    // gate during legacy-app-repair, 2026-08-31.
    //
    // Emitted HERE rather than in AdminKycReviewService because both the admin
    // queue and the original POST /kyc/:id/review route delegate to this one
    // method — putting it in the caller would notify from one path and not the
    // other.
    await this.notifications.emit({
      kind: 'kyc_verified',
      userWawuId: submission.wawuUserId,
      approved: dto.decision === 'approved',
    });

    return updated;
  }
}
