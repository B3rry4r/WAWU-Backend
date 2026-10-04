import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { WawuIdClient } from '../common/auth/wawu-id.client';
import { deriveVerificationState } from '../common/verification/verification-state';
import { BlockedAccountService } from '../blocked-account/blocked-account.service';
import { AccountType, ContentStatus } from '../../generated/prisma/enums';
import type { VerificationState } from '../common/verification/verification-state';
import { EXPLORE_CATEGORIES, interestSpellings } from './explore-categories';
import type {
  ExploreCreatorsQueryDto,
  FeaturedCreatorsQueryDto,
} from './dto/explore-creators-query.dto';

/** One creator card, the same fields the older GET /creators serves. */
export interface ExploreCreatorCard {
  wawuId: string;
  name: string;
  handle: string | null;
  avatarUrl: string | null;
  field: string | null;
  pieceCount: number;
  verification: VerificationState;
  following: boolean;
}

const DEFAULT_PER_PAGE = 24;
const DEFAULT_FEATURED = 10;

/**
 * Explore's category chips and featured creators (EXPLORE-03).
 *
 * Who may appear, on both lists, is decided in one place (`eligibleIds`):
 * a creator profile with at least one live piece (the same promise the older
 * GET /creators makes), who is not blocked either way with the viewer, and
 * who has not switched "show me in member lists" off. A hidden person is left
 * out of the list and of `total`, so nothing tells a blocked creator from one
 * who is simply not there.
 */
@Injectable()
export class ExploreService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wawuId: WawuIdClient,
    private readonly blockedAccounts: BlockedAccountService,
  ) {}

  categories() {
    return { items: EXPLORE_CATEGORIES.map((c) => ({ ...c })) };
  }

  /** Creators this viewer may be shown, with their live piece counts. */
  private async eligible(viewer: string | null): Promise<Map<string, number>> {
    const live = await this.prisma.contentPiece.groupBy({
      by: ['creatorWawuId'],
      where: { status: ContentStatus.live },
      _count: { _all: true },
    });
    const hidden = new Set(await this.blockedAccounts.hiddenFrom(viewer));
    const counts = new Map<string, number>();
    for (const l of live) {
      if (!hidden.has(l.creatorWawuId))
        counts.set(l.creatorWawuId, l._count._all);
    }
    if (counts.size === 0) return counts;
    const private_ = await this.prisma.privacySettings.findMany({
      where: {
        userWawuId: { in: [...counts.keys()] },
        showInMemberLists: false,
      },
      select: { userWawuId: true },
    });
    for (const p of private_) counts.delete(p.userWawuId);
    return counts;
  }

  private async cards(
    profiles: Array<{
      wawuUserId: string;
      handle: string | null;
      interests: string[];
      avatarUrl: string | null;
      creatorVerifiedAt: Date | null;
      creatorVerifiedUntil: Date | null;
      professionalVerifiedAt: Date | null;
      professionalVerifiedUntil: Date | null;
    }>,
    counts: Map<string, number>,
    viewer: string | null,
  ): Promise<ExploreCreatorCard[]> {
    if (profiles.length === 0) return [];
    const ids = profiles.map((p) => p.wawuUserId);
    const [identities, following] = await Promise.all([
      this.wawuId.lookupPublicIdentities(ids),
      viewer
        ? this.prisma.followRelationship.findMany({
            where: { followerWawuId: viewer, followingWawuId: { in: ids } },
            select: { followingWawuId: true },
          })
        : Promise.resolve([]),
    ]);
    const followingSet = new Set(following.map((f) => f.followingWawuId));
    return profiles
      .map((p) => {
        const identity = identities.get(p.wawuUserId);
        const fullName = [identity?.firstName, identity?.lastName]
          .filter(Boolean)
          .join(' ')
          .trim();
        return {
          wawuId: p.wawuUserId,
          name: fullName || p.handle || '',
          handle: p.handle,
          avatarUrl: p.avatarUrl,
          field: p.interests[0] ?? null,
          pieceCount: counts.get(p.wawuUserId) ?? 0,
          verification: deriveVerificationState(p),
          following: followingSet.has(p.wawuUserId),
        };
      })
      .filter((i) => i.name !== '');
  }

  private static readonly PROFILE_SELECT = {
    wawuUserId: true,
    handle: true,
    interests: true,
    avatarUrl: true,
    creatorVerifiedAt: true,
    creatorVerifiedUntil: true,
    professionalVerifiedAt: true,
    professionalVerifiedUntil: true,
  } as const;

  async creators(query: ExploreCreatorsQueryDto, viewer: string | null) {
    const page = query.page ?? 1;
    const perPage = query.perPage ?? DEFAULT_PER_PAGE;
    const counts = await this.eligible(viewer);
    if (counts.size === 0) {
      return { items: [], currentPage: page, perPage, total: 0 };
    }
    const where = {
      accountType: AccountType.creator,
      wawuUserId: { in: [...counts.keys()] },
      ...(query.category
        ? { interests: { hasSome: interestSpellings(query.category) } }
        : {}),
    };
    const [profiles, total] = await Promise.all([
      this.prisma.userProfile.findMany({
        where,
        select: ExploreService.PROFILE_SELECT,
        orderBy: [{ handle: 'asc' }, { wawuUserId: 'asc' }],
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.userProfile.count({ where }),
    ]);
    return {
      items: await this.cards(profiles, counts, viewer),
      currentPage: page,
      perPage,
      total,
    };
  }

  async featured(query: FeaturedCreatorsQueryDto, viewer: string | null) {
    const limit = query.limit ?? DEFAULT_FEATURED;
    const counts = await this.eligible(viewer);
    const rows = await this.prisma.featuredCreator.findMany({
      where: { wawuUserId: { in: [...counts.keys()] } },
      orderBy: [
        { position: 'asc' },
        { createdAt: 'asc' },
        { wawuUserId: 'asc' },
      ],
    });
    if (rows.length === 0) return { items: [] };
    const profiles = await this.prisma.userProfile.findMany({
      where: {
        accountType: AccountType.creator,
        wawuUserId: { in: rows.map((r) => r.wawuUserId) },
      },
      select: ExploreService.PROFILE_SELECT,
    });
    const byId = new Map(profiles.map((p) => [p.wawuUserId, p]));
    const ordered = rows
      .map((r) => byId.get(r.wawuUserId))
      .filter((p): p is NonNullable<typeof p> => !!p);
    // Names are known only after the lookup, so take the limit afterwards.
    const items = await this.cards(ordered, counts, viewer);
    return { items: items.slice(0, limit) };
  }
}
