import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { AccountType, ContentStatus } from '../../generated/prisma/enums';
import { PrismaService } from '../common/prisma/prisma.service';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import type {
  CreatorProfile,
  UserProfile,
  UserProfileWithClaims,
} from '../common/types';
import type { UpdateUserProfileDto } from './dto/update-user-profile.dto';

/**
 * registry.json "UserProfile". Owns GET/PATCH /users/me and the public
 * GET /users/:wawuId/public-profile aggregate (UserProfile + CreatorState +
 * EvgScore + content/follower/community summaries per the registry note).
 */
@Injectable()
export class UserProfileService {
  constructor(private readonly prisma: PrismaService) {}

  async getMe(user: WawuJwtClaims): Promise<UserProfileWithClaims> {
    const profile = await this.prisma.userProfile.findUnique({
      where: { wawuUserId: user.sub },
    });

    // PATCH /users/me creates the row on first call (registry endpoint
    // note: post-WAWU-ID-signup onboarding). A caller who has signed up
    // with WAWU ID but not yet completed WAWUAfrica onboarding legitimately
    // has no row yet — the onboarding screen itself calls GET first to
    // prefill, so this must succeed with empty defaults (accountType/
    // createdAt null), never 404. The registry's declared response shape
    // (non-null accountType/createdAt) describes the post-onboarding case;
    // this pre-onboarding shape is a deliberate, documented deviation.
    const base = profile ?? {
      accountType: null,
      handle: null,
      bio: null,
      interests: [] as string[],
      instagramHandle: null,
      xHandle: null,
      tiktokHandle: null,
      youtubeUrl: null,
      facebookUrl: null,
      linkedinUrl: null,
      whatsappHandle: null,
      websiteUrl: null,
      createdAt: null,
    };

    return { ...user, ...base, wawuUserId: user.sub } as UserProfileWithClaims;
  }

  async upsertMe(
    wawuUserId: string,
    dto: UpdateUserProfileDto,
  ): Promise<UserProfile> {
    try {
      return await this.prisma.userProfile.upsert({
        where: { wawuUserId },
        update: {
          // `accountType` is deliberately self-selectable (CLAUDE.md: creator
          // is an ACCOUNT TYPE, not an earned tier — the paid gate is
          // CreatorState.subscriptionPaid, checked separately). But the
          // column is NOT nullable, so an explicit `null` must be ignored
          // rather than written, which previously 500'd.
          ...(dto.accountType != null && {
            accountType: dto.accountType as AccountType,
          }),
          ...(dto.interests !== undefined && { interests: dto.interests }),
          ...(dto.bio !== undefined && { bio: dto.bio }),
          ...(dto.handle !== undefined && { handle: dto.handle }),
          ...Object.fromEntries(
            ([
              'xHandle',
              'tiktokHandle',
              'youtubeUrl',
              'facebookUrl',
              'linkedinUrl',
              'websiteUrl',
            ] as const)
              .filter((k) => dto[k] !== undefined)
              .map((k) => [k, dto[k]]),
          ),
          ...(dto.instagramHandle !== undefined && {
            instagramHandle: dto.instagramHandle,
          }),
          ...(dto.whatsappHandle !== undefined && {
            whatsappHandle: dto.whatsappHandle,
          }),
        },
        create: {
          wawuUserId,
          accountType: dto.accountType ?? AccountType.user,
          handle: dto.handle ?? null,
          bio: dto.bio ?? null,
          interests: dto.interests ?? [],
          instagramHandle: dto.instagramHandle ?? null,
          xHandle: dto.xHandle ?? null,
          tiktokHandle: dto.tiktokHandle ?? null,
          youtubeUrl: dto.youtubeUrl ?? null,
          facebookUrl: dto.facebookUrl ?? null,
          linkedinUrl: dto.linkedinUrl ?? null,
          websiteUrl: dto.websiteUrl ?? null,
          whatsappHandle: dto.whatsappHandle ?? null,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new BadRequestException('handle is already taken');
      }
      throw error;
    }
  }

  /**
   * Accepts either a wawuUserId or a handle.
   *
   * Profiles are shared by username, not by an opaque id, so a link somebody
   * actually sends to a friend has to resolve. The id is tried first because
   * that is what the app's own internal links use; a handle lookup only runs
   * when that misses.
   */
  async getPublicProfile(idOrHandle: string): Promise<CreatorProfile> {
    const profile =
      (await this.prisma.userProfile.findUnique({
        where: { wawuUserId: idOrHandle },
      })) ??
      (await this.prisma.userProfile.findUnique({
        where: { handle: idOrHandle.replace(/^@/, '') },
      }));
    if (!profile) {
      throw new NotFoundException('User not found');
    }
    const wawuUserId = profile.wawuUserId;

    const creatorState = await this.prisma.creatorState.findUnique({
      where: { wawuUserId },
    });
    if (!creatorState) {
      // The resource concept (public creator profile) exists but this
      // account isn't entitled to one — a plain `user` account type has no
      // CreatorState row (mirrors CreatorStateService's own precedent).
      throw new NotFoundException('This account has no public creator profile');
    }

    const [evgScore, contentCount, followerCount, communityCount] =
      await this.prisma.$transaction([
        this.prisma.evgScore.findUnique({
          where: { creatorWawuId: wawuUserId },
        }),
        this.prisma.contentPiece.count({
          where: { creatorWawuId: wawuUserId, status: ContentStatus.live },
        }),
        this.prisma.followRelationship.count({
          where: { followingWawuId: wawuUserId },
        }),
        this.prisma.community.count({ where: { hostWawuId: wawuUserId } }),
      ]);

    return {
      wawuUserId: profile.wawuUserId,
      handle: profile.handle,
      bio: profile.bio,
      interests: profile.interests,
      instagramHandle: profile.instagramHandle,
      xHandle: profile.xHandle,
      tiktokHandle: profile.tiktokHandle,
      youtubeUrl: profile.youtubeUrl,
      facebookUrl: profile.facebookUrl,
      linkedinUrl: profile.linkedinUrl,
      whatsappHandle: profile.whatsappHandle,
      websiteUrl: profile.websiteUrl,
      tier: creatorState.tier,
      evgScore: evgScore?.score ?? 0,
      contentCount,
      followerCount,
      communityCount,
    };
  }
}
