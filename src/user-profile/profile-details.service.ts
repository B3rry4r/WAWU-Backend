import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { BlockedAccountService } from '../blocked-account/blocked-account.service';
import type { UpdateProfileFieldsDto } from './dto/update-profile-fields.dto';
import { normaliseHandle } from './social-handles';
import { memberSinceOf, normaliseChips, normaliseText } from './profile-fields';
import type { ProfileFieldsView } from './profile-fields.type';

/**
 * The ME-05 profile fields: location, skills, "open to", Threads and the
 * order of the social links, plus "member since".
 *
 * They are their own table (ProfileDetails) and their own routes, so the
 * answers of GET and PATCH /users/me and of the public profile stay exactly
 * what the web reads today. See the schema's note on ProfileDetails.
 */
@Injectable()
export class ProfileDetailsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly blockedAccounts: BlockedAccountService,
  ) {}

  /** The caller's own fields. Never 404s: no row means nothing set yet. */
  async getMine(wawuUserId: string): Promise<ProfileFieldsView> {
    return this.view(wawuUserId);
  }

  /**
   * Somebody else's fields, by WAWU ID or by handle (as the public profile
   * accepts). Exactly the accounts that have a public profile have these:
   * a profile row AND a creator state, else the same 404 the public profile
   * gives, so these routes never show what that one withholds. Reading them
   * counts no profile view; the profile read already does.
   */
  async getPublic(
    idOrHandle: string,
    viewerWawuId?: string,
  ): Promise<ProfileFieldsView> {
    const profile =
      (await this.prisma.userProfile.findUnique({
        where: { wawuUserId: idOrHandle },
        select: { wawuUserId: true },
      })) ??
      (await this.prisma.userProfile.findUnique({
        where: { handle: idOrHandle.replace(/^@/, '') },
        select: { wawuUserId: true },
      }));
    if (!profile) {
      throw new NotFoundException('User not found');
    }
    // SETTINGS-04: a hidden account's fields answer like a missing user.
    await this.blockedAccounts.assertVisible(
      viewerWawuId,
      profile.wawuUserId,
      'User not found',
    );
    const creatorState = await this.prisma.creatorState.findUnique({
      where: { wawuUserId: profile.wawuUserId },
      select: { wawuUserId: true },
    });
    if (!creatorState) {
      throw new NotFoundException('This account has no public creator profile');
    }
    return this.view(profile.wawuUserId);
  }

  /**
   * Saves the keys that were sent and leaves the rest. Creates the row on the
   * first save. Opens no wallet and touches no UserProfile row.
   */
  async updateMine(
    wawuUserId: string,
    dto: UpdateProfileFieldsDto,
  ): Promise<ProfileFieldsView> {
    const data = {
      ...(dto.location !== undefined && {
        location: normaliseText(dto.location),
      }),
      ...(dto.threadsHandle !== undefined && {
        threadsHandle: normaliseHandle(dto.threadsHandle),
      }),
      ...(dto.skills != null && { skills: normaliseChips(dto.skills) }),
      ...(dto.openTo != null && { openTo: normaliseChips(dto.openTo) }),
      ...(dto.socialOrder != null && { socialOrder: dto.socialOrder }),
    };
    await this.prisma.profileDetails.upsert({
      where: { wawuUserId },
      update: data,
      create: { wawuUserId, ...data },
    });
    return this.view(wawuUserId);
  }

  private async view(wawuUserId: string): Promise<ProfileFieldsView> {
    const [details, profile] = await Promise.all([
      this.prisma.profileDetails.findUnique({ where: { wawuUserId } }),
      this.prisma.userProfile.findUnique({
        where: { wawuUserId },
        select: { createdAt: true },
      }),
    ]);
    return {
      wawuUserId,
      location: details?.location ?? null,
      skills: details?.skills ?? [],
      openTo: details?.openTo ?? [],
      threadsHandle: details?.threadsHandle ?? null,
      socialOrder: details?.socialOrder ?? [],
      memberSince: memberSinceOf(profile?.createdAt),
    };
  }
}
