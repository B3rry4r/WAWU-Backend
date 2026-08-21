import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import type { CreatorTier } from '../../generated/prisma/enums';
import type { CreatorStateResponse } from '../common/types/creator-state.type';
import type { UpdateDmSettingsDto } from './dto/update-dm-settings.dto';
import { uploadAllowanceFor } from '../common/creator-tier-allowance';


/**
 * CreatorState is the creator-only entitlement/gate resource (CLAUDE.md: two
 * independent gates — subscriptionPaid gates uploading, kycStatus gates
 * earning). Both endpoints on this resource require the caller to already
 * be a creator: the "creator" role in the registry's endpoint contract is
 * enforced here by requiring a CreatorState row to exist for the caller's
 * wawuUserId (a plain user, e.g. the seeded 00000000-...-000000000001, has
 * none — a 403, not a 404, since the resource concept exists, they simply
 * aren't entitled to it).
 */
@Injectable()
export class CreatorStateService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * `kycStatus` is stored as a ReviewStatus, whose `pending` covers two states
   * that are nothing alike: "has never started KYC" and "submitted, waiting on
   * a reviewer". Reporting both as pending told creators who had done nothing
   * that their verification was in review, with no way to begin it.
   *
   * The distinction is derived from whether a KycSubmission actually exists
   * rather than stored, so it cannot drift out of step with the submissions
   * table.
   */
  private toResponse(state: {
    wawuUserId: string;
    tier: CreatorTier;
    subscriptionPaid: boolean;
    kycStatus: string;
    slotsUsed: number;
    dmPrice: number | null;
    dmEnabled: boolean;
  }, hasSubmitted = true): CreatorStateResponse {
    return {
      ...state,
      kycStatus:
        state.kycStatus === 'pending' && !hasSubmitted
          ? 'not_started'
          : state.kycStatus,
      slotsTotal: uploadAllowanceFor(state.tier).total,
    } as CreatorStateResponse;
  }

  async getState(wawuUserId: string): Promise<CreatorStateResponse> {
    const [state, submissionCount] = await Promise.all([
      this.prisma.creatorState.findUnique({ where: { wawuUserId } }),
      this.prisma.kycSubmission.count({ where: { wawuUserId } }),
    ]);
    if (!state) {
      throw new ForbiddenException('This account has no creator state — a creator account type is required.');
    }
    return this.toResponse(state, submissionCount > 0);
  }

  async updateDmSettings(wawuUserId: string, dto: UpdateDmSettingsDto): Promise<CreatorStateResponse> {
    const [existing, submissionCount] = await Promise.all([
      this.prisma.creatorState.findUnique({ where: { wawuUserId } }),
      this.prisma.kycSubmission.count({ where: { wawuUserId } }),
    ]);
    if (!existing) {
      throw new ForbiddenException('This account has no creator state — a creator account type is required.');
    }
    const updated = await this.prisma.creatorState.update({
      where: { wawuUserId },
      data: { dmEnabled: dto.dmEnabled, dmPrice: dto.dmPrice },
    });
    // Must pass `hasSubmitted` through, exactly as getState does. Letting it
    // default to `true` made this endpoint report 'pending' for an account
    // GET /creator/state reported as 'not_started' — the same creator saw two
    // different KYC states depending on which call refreshed the screen.
    return this.toResponse(updated, submissionCount > 0);
  }
}
