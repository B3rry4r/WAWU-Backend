import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { WawuIdClient } from '../common/auth/wawu-id.client';
import { AccountType, ContentStatus } from '../../generated/prisma/enums';
import type { ListCreatorsQueryDto } from './dto/list-creators-query.dto';

/** One card in a creator list. Exactly what the grid renders, nothing more. */
export interface CreatorDiscoveryItem {
  wawuId: string;
  /** Real display name from WAWU ID, falling back to the handle. */
  name: string;
  handle: string | null;
  /** What they do — their first interest. Null when they have listed none. */
  field: string | null;
  /** Live pieces only. A draft or rejected upload is not something to browse. */
  pieceCount: number;
  /** Public badge tier from WAWU ID. Never their KYC state, which is private. */
  verification: string;
  /** Whether the CALLER follows them. False for an anonymous reader. */
  following: boolean;
}

const DEFAULT_PER_PAGE = 24;

/**
 * Creator discovery — the list behind Explore.
 *
 * This endpoint did not exist, and its absence is why the consumer app's
 * creator lists were mock data with fabricated ids like "wawu-adaeze". There
 * was no way to ask this backend "who are the creators": `/users/:id/public-
 * profile` is a single read, and `/search` requires a non-empty `q`, so
 * browsing was structurally impossible and the frontend invented people.
 *
 * Identity is not this backend's to hold. Names and badge tiers live on WAWU
 * ID and are fetched per page through WawuIdClient. When that lookup fails the
 * list still renders, with handles standing in for names — a directory that
 * disappears because a sibling service is briefly unreachable is worse than a
 * directory showing handles.
 */
@Injectable()
export class CreatorDiscoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wawuId: WawuIdClient,
  ) {}

  async list(query: ListCreatorsQueryDto, requesterWawuId: string | null) {
    const page = query.page ?? 1;
    const perPage = query.perPage ?? DEFAULT_PER_PAGE;

    const where = {
      accountType: AccountType.creator,
      ...(query.category
        ? {
            interests: {
              // Postgres array containment is exact and case-sensitive, so a
              // profile tagged "Agriculture" would not match a filter of
              // "agriculture". Case is normalised by comparing against both
              // forms rather than lowercasing the column, which would need an
              // expression index to stay fast.
              hasSome: [
                query.category,
                query.category.toLowerCase(),
                query.category.toUpperCase(),
                query.category.charAt(0).toUpperCase() +
                  query.category.slice(1).toLowerCase(),
              ],
            },
          }
        : {}),
    };

    const [profiles, total] = await Promise.all([
      this.prisma.userProfile.findMany({
        where,
        select: { wawuUserId: true, handle: true, interests: true },
        // A stable order, so page 2 is not page 1 again. `handle` is unique
        // where set; wawuUserId breaks the tie for profiles without one.
        orderBy: [{ handle: 'asc' }, { wawuUserId: 'asc' }],
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.userProfile.count({ where }),
    ]);

    if (profiles.length === 0) {
      return { items: [], currentPage: page, perPage, total };
    }

    const ids = profiles.map((p) => p.wawuUserId);

    const [identities, pieceCounts, following] = await Promise.all([
      this.wawuId.lookupPublicIdentities(ids),
      this.prisma.contentPiece.groupBy({
        by: ['creatorWawuId'],
        where: { creatorWawuId: { in: ids }, status: ContentStatus.live },
        _count: { _all: true },
      }),
      requesterWawuId
        ? this.prisma.followRelationship.findMany({
            where: {
              followerWawuId: requesterWawuId,
              followingWawuId: { in: ids },
            },
            select: { followingWawuId: true },
          })
        : Promise.resolve([]),
    ]);

    const pieceCountBy = new Map(
      pieceCounts.map((c) => [c.creatorWawuId, c._count._all]),
    );
    const followingSet = new Set(following.map((f) => f.followingWawuId));

    const items: CreatorDiscoveryItem[] = profiles.map((p) => {
      const identity = identities.get(p.wawuUserId);
      const fullName = [identity?.firstName, identity?.lastName]
        .filter(Boolean)
        .join(' ')
        .trim();

      return {
        wawuId: p.wawuUserId,
        // Handle, then the id, rather than an empty string — a card with a
        // blank name reads as a broken row.
        name: fullName || p.handle || p.wawuUserId,
        handle: p.handle,
        field: p.interests[0] ?? null,
        pieceCount: pieceCountBy.get(p.wawuUserId) ?? 0,
        verification: identity?.verificationTier ?? 'basic',
        following: followingSet.has(p.wawuUserId),
      };
    });

    return { items, currentPage: page, perPage, total };
  }
}
