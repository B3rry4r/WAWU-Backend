import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import type { CreatorTier } from '../../generated/prisma/enums';
import type { CreatorStateResponse } from '../common/types/creator-state.type';
import type { UpdateDmSettingsDto } from './dto/update-dm-settings.dto';

/**
 * Upload-slot totals per tier — NOT a stored column (schema agent's own
 * judgment call, see prisma/schema.prisma CreatorState doc comment).
 * Confirmed against design/screens/WAWU Subscription Management.dc.html:
 * Basic = 3 upload slots ("3 uploads · 85/15 split", "Upload slots ... 2 of
 * 3"), Pro = 7 ("7 upload slots instead of 3").
 */
const SLOTS_TOTAL_BY_TIER: Record<CreatorTier, number> = {
  basic: 3,
  pro: 7,
};

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

  private toResponse(state: {
    wawuUserId: string;
    tier: CreatorTier;
    subscriptionPaid: boolean;
    kycStatus: string;
    slotsUsed: number;
    dmPrice: number | null;
    dmEnabled: boolean;
  }): CreatorStateResponse {
    return {
      ...state,
      slotsTotal: SLOTS_TOTAL_BY_TIER[state.tier],
    } as CreatorStateResponse;
  }

  async getState(wawuUserId: string): Promise<CreatorStateResponse> {
    const state = await this.prisma.creatorState.findUnique({ where: { wawuUserId } });
    if (!state) {
      throw new ForbiddenException('This account has no creator state — a creator account type is required.');
    }
    return this.toResponse(state);
  }

  async updateDmSettings(wawuUserId: string, dto: UpdateDmSettingsDto): Promise<CreatorStateResponse> {
    const existing = await this.prisma.creatorState.findUnique({ where: { wawuUserId } });
    if (!existing) {
      throw new ForbiddenException('This account has no creator state — a creator account type is required.');
    }
    const updated = await this.prisma.creatorState.update({
      where: { wawuUserId },
      data: { dmEnabled: dto.dmEnabled, dmPrice: dto.dmPrice },
    });
    return this.toResponse(updated);
  }
}
