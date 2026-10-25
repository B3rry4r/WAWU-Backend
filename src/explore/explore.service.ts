import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { WawuIdClient } from '../common/auth/wawu-id.client';
import { deriveVerificationState } from '../common/verification/verification-state';
import { BlockedAccountService } from '../blocked-account/blocked-account.service';
import { ContentStatus } from '../../generated/prisma/enums';
import { Prisma } from '../../generated/prisma/client';
import { StorageService, objectKeyFrom } from '../storage/storage.service';
import type { VerificationState } from '../common/verification/verification-state';
import type { PersonBadgeView } from '../plans/tier-badge/person-badge-view.type';
import { TierBadgeService } from '../plans/tier-badge/tier-badge.service';
import { EXPLORE_CATEGORIES, normaliseInterest } from './explore-categories';
import type {
  ExploreCreatorsQueryDto,
  FeaturedCreatorsQueryDto,
  SuggestedCreatorsQueryDto,
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
  /**
   * Their tier badge while a tier runs, else null (TIER-07): the pill beside
   * the name, with the Founding Maker number.
   */
  badge: PersonBadgeView | null;
  following: boolean;
}

const DEFAULT_PER_PAGE = 24;
const DEFAULT_FEATURED = 10;
const DEFAULT_SUGGESTED = 10;

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
    private readonly storage: StorageService,
    private readonly badges: TierBadgeService,
  ) {}

  categories() {
    return { items: EXPLORE_CATEGORIES.map((c) => ({ ...c })) };
  }

  /**
   * Who this viewer may be shown, as one SQL fragment: a creator profile with
   * something live, not blocked either way, not off member lists, and (when
   * given) in the category. Decided in the database and paged there, so no
   * list of ids ever travels as bind parameters (the only array is the
   * viewer's own blocks, bound as one value).
   */
  private async eligibleFrom(
    viewer: string | null,
    category?: string,
    anyOf?: string[],
  ) {
    const hidden = await this.blockedAccounts.hiddenFrom(viewer);
    const inCategory = category
      ? Prisma.sql`AND EXISTS (SELECT 1 FROM unnest(p."interests") AS i
          WHERE regexp_replace(lower(i), '[^a-z0-9]', '', 'g') = ${normaliseInterest(category)}::text)`
      : Prisma.empty;
    // AUTH-06: in any of several categories (the keys are normaliseInterest values).
    const inAny =
      anyOf && anyOf.length > 0
        ? Prisma.sql`AND EXISTS (SELECT 1 FROM unnest(p."interests") AS i
          WHERE regexp_replace(lower(i), '[^a-z0-9]', '', 'g') = ANY(${anyOf}::text[]))`
        : Prisma.empty;
    return Prisma.sql`
      FROM "UserProfile" p
      WHERE p."accountType" = 'creator'::"AccountType"
        AND EXISTS (SELECT 1 FROM "ContentPiece" c
          WHERE c."creatorWawuId" = p."wawuUserId" AND c."status" = 'live'::"ContentStatus")
        AND NOT EXISTS (SELECT 1 FROM "PrivacySettings" s
          WHERE s."userWawuId" = p."wawuUserId" AND s."showInMemberLists" = false)
        AND p."wawuUserId" <> ALL(${hidden}::text[])
        ${inCategory}
        ${inAny}`;
  }

  private async cardsFor(ids: string[], viewer: string | null) {
    if (ids.length === 0) return [];
    const [profiles, live] = await Promise.all([
      this.prisma.userProfile.findMany({
        where: { wawuUserId: { in: ids } },
        select: ExploreService.PROFILE_SELECT,
      }),
      this.prisma.contentPiece.groupBy({
        by: ['creatorWawuId'],
        where: { status: ContentStatus.live, creatorWawuId: { in: ids } },
        _count: { _all: true },
      }),
    ]);
    const byId = new Map(profiles.map((p) => [p.wawuUserId, p]));
    const counts = new Map(live.map((l) => [l.creatorWawuId, l._count._all]));
    const ordered = ids
      .map((id) => byId.get(id))
      .filter((p): p is NonNullable<typeof p> => !!p);
    return this.cards(ordered, counts, viewer);
  }

  /**
   * A stored image, made readable again. Stored values are often 7-day signed
   * URLs. Only a key shaped `<folder>/<this creator>/<file>` in the one folder that kind of image lives in is signed; a key
   * of another account, or one that cannot be read as a key, is never signed
   * (a link from our own storage that is not theirs is dropped, a link to
   * somewhere else passes through untouched).
   */
  private async freshOwnImage(
    stored: string | null,
    folder: string,
    ownerId: string,
  ): Promise<string | null> {
    if (!stored) return null;
    const key = objectKeyFrom(stored);
    if (key === stored) {
      return /^https?:\/\//i.test(stored) ? stored : null;
    }
    const prefix = `${folder}/${ownerId}/`;
    if (!key.startsWith(prefix) || key.slice(prefix.length).includes('/')) {
      return null;
    }
    return this.storage.freshUrlFor(stored);
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
    const [identities, following, badgeBy] = await Promise.all([
      this.wawuId.lookupPublicIdentities(ids),
      viewer
        ? this.prisma.followRelationship.findMany({
            where: { followerWawuId: viewer, followingWawuId: { in: ids } },
            select: { followingWawuId: true },
          })
        : Promise.resolve([]),
      this.badges.forMany(ids),
    ]);
    const followingSet = new Set(following.map((f) => f.followingWawuId));
    const avatars = await Promise.all(
      profiles.map((p) =>
        this.freshOwnImage(p.avatarUrl, 'avatars', p.wawuUserId),
      ),
    );
    return profiles
      .map((p, idx) => {
        const identity = identities.get(p.wawuUserId);
        const fullName = [identity?.firstName, identity?.lastName]
          .filter(Boolean)
          .join(' ')
          .trim();
        return {
          wawuId: p.wawuUserId,
          name: fullName || p.handle || '',
          handle: p.handle,
          avatarUrl: avatars[idx],
          field: p.interests[0] ?? null,
          pieceCount: counts.get(p.wawuUserId) ?? 0,
          verification: deriveVerificationState(p),
          badge: badgeBy.get(p.wawuUserId) ?? null,
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
    const from = await this.eligibleFrom(viewer, query.category);
    const [rows, total] = await Promise.all([
      this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT p."wawuUserId" AS id ${from}
        ORDER BY p."handle" ASC, p."wawuUserId" ASC
        LIMIT ${perPage} OFFSET ${(page - 1) * perPage}`,
      this.prisma.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*) AS n ${from}`,
    ]);
    return {
      items: await this.cardsFor(
        rows.map((r) => r.id),
        viewer,
      ),
      currentPage: page,
      perPage,
      total: Number(total[0]?.n ?? 0),
    };
  }

  async featured(query: FeaturedCreatorsQueryDto, viewer: string | null) {
    const limit = query.limit ?? DEFAULT_FEATURED;
    const from = await this.eligibleFrom(viewer);
    const items: ExploreCreatorCard[] = [];
    // Names are known only after the lookup, so read the rail in small
    // batches until it holds `limit` named creators or runs out.
    for (let offset = 0; items.length < limit && offset < 200; offset += 50) {
      const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT p."wawuUserId" AS id ${from}
          AND EXISTS (SELECT 1 FROM "FeaturedCreator" f WHERE f."wawuUserId" = p."wawuUserId")
        ORDER BY (SELECT f."position" FROM "FeaturedCreator" f WHERE f."wawuUserId" = p."wawuUserId") ASC,
                 (SELECT f."createdAt" FROM "FeaturedCreator" f WHERE f."wawuUserId" = p."wawuUserId") ASC,
                 p."wawuUserId" ASC
        LIMIT 50 OFFSET ${offset}`;
      if (rows.length === 0) break;
      items.push(
        ...(await this.cardsFor(
          rows.map((r) => r.id),
          viewer,
        )),
      );
      if (rows.length < 50) break;
    }
    return { items: items.slice(0, limit) };
  }

  /**
   * People to follow at the end of sign-up (A13, AUTH-06): the same creators
   * Explore may show this viewer, those who match the most of the picked
   * categories first, then by handle. No picks is the plain list. The viewer
   * is never in their own list.
   *
   * R2-AUTHME3: when the picks match fewer creators than the list holds
   * (`limit`), the rest of it is every other creator Explore may show, the most
   * followed first (then by handle), so a new person is not left with an empty
   * screen because no creator has saved one of the same interests. The matches
   * always come first and are never pushed out by the fill.
   */
  async suggested(query: SuggestedCreatorsQueryDto, viewer: string | null) {
    const limit = query.limit ?? DEFAULT_SUGGESTED;
    const keys = [...new Set((query.interests ?? []).map(normaliseInterest))];
    const from = await this.eligibleFrom(viewer, undefined, keys);
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT p."wawuUserId" AS id ${from}
        AND p."wawuUserId" <> ${viewer ?? ''}::text
      ORDER BY (SELECT count(DISTINCT regexp_replace(lower(i), '[^a-z0-9]', '', 'g'))
                  FROM unnest(p."interests") AS i
                 WHERE regexp_replace(lower(i), '[^a-z0-9]', '', 'g') = ANY(${keys}::text[])) DESC,
               p."handle" ASC, p."wawuUserId" ASC
      LIMIT ${limit}`;
    const ids = rows.map((r) => r.id);
    if (keys.length > 0 && ids.length < limit) {
      const everyone = await this.eligibleFrom(viewer);
      const rest = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT p."wawuUserId" AS id ${everyone}
          AND p."wawuUserId" <> ${viewer ?? ''}::text
          AND p."wawuUserId" <> ALL(${ids}::text[])
        ORDER BY (SELECT count(*) FROM "FollowRelationship" f
                   WHERE f."followingWawuId" = p."wawuUserId") DESC,
                 p."handle" ASC, p."wawuUserId" ASC
        LIMIT ${limit - ids.length}`;
      ids.push(...rest.map((r) => r.id));
    }
    return { items: await this.cardsFor(ids, viewer) };
  }
}
