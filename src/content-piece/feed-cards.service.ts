import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { WawuIdClient } from '../common/auth/wawu-id.client';
import {
  deriveVerificationState,
  type VerificationState,
} from '../common/verification/verification-state';
import { StorageService } from '../storage/storage.service';

/**
 * PROVISIONAL(FEED-CARD-EVERY, owner=YOU, why=H9 and H10 draw cards among content without saying how often one appears)
 *
 * One creator or professional card after every this-many pieces of content.
 * Cards alternate creator, professional, creator, and so on.
 */
export const FEED_CARD_EVERY = 5;

/** The most pieces a creator card's strip of work shows (H9 draws four). */
export const CARD_WORKS = 4;

/** The most "people you know" a creator card names (H9 draws three faces). */
export const CARD_KNOWN_FOLLOWERS = 3;

/** Who made a piece, on the card, so the app needs no call per card. */
export interface FeedCreator {
  wawuId: string;
  /** Real name from WAWU ID, else the handle; null when neither exists. */
  displayName: string | null;
  handle: string | null;
  avatarUrl: string | null;
  /** Both ticks, decided server-side (never a rank). */
  verification: VerificationState;
}

/** A person the viewer follows who also follows the card's creator. */
export interface KnownFollower {
  wawuId: string;
  displayName: string | null;
  avatarUrl: string | null;
}

/** One piece in a creator card's strip. */
export interface CardWork {
  id: string;
  contentType: string;
  accessType: string;
  /** As stored on the piece: the same value `GET /content` serves. */
  price: number;
  /** Paid and the viewer has not bought it. */
  locked: boolean;
  title: string;
  thumbnailUrl: string | null;
  durationLabel: string | null;
  pageCount: number | null;
  /** Pictures in a photo set; 0 for anything else. */
  frameCount: number;
  views: number;
}

/** H9: the creator card. */
export interface CreatorCard {
  wawuId: string;
  displayName: string | null;
  handle: string | null;
  /** The headline the person wrote for themselves, if they have. */
  headline: string | null;
  avatarUrl: string | null;
  /** The wide image behind the profile; the card falls back to the avatar. */
  coverUrl: string | null;
  verification: VerificationState;
  followers: number;
  /** Live pieces. */
  posts: number;
  /**
   * Mean of the ratings on their live pieces, out of 5, to one decimal. Null
   * when no piece has been rated: no stars, never a zero.
   */
  rating: number | null;
  /** People the viewer follows who follow this creator. */
  knownFollowers: { count: number; people: KnownFollower[] };
  works: CardWork[];
  /** Always false: people the viewer already follows are not suggested. */
  followsCreator: boolean;
}

/** H10: the professional card. */
export interface ProfessionalCard {
  /** The listing id (`GET /professionals/:id`). */
  id: string;
  wawuId: string;
  displayName: string | null;
  handle: string | null;
  headline: string;
  avatarUrl: string | null;
  coverUrl: string | null;
  verification: VerificationState;
  category: string;
  /** What they help with: the chips. */
  services: string[];
  ratingAvg: number | null;
  reviewCount: number;
  /** What a paid message costs, as stored (the value `GET /professionals` serves); always above 0. */
  dmPrice: number;
  /** Hours they have to reply before the payer's money is returned. */
  dmResponseHours: number;
}

/** One entry of GET /feed/entries. */
export type FeedCardEntry =
  | { kind: 'creator'; creator: CreatorCard }
  | { kind: 'professional'; professional: ProfessionalCard };

function roundToOneDecimal(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10) / 10;
}

function fullName(
  identity: { firstName: string | null; lastName: string | null } | undefined,
): string {
  return [identity?.firstName, identity?.lastName]
    .filter(Boolean)
    .join(' ')
    .trim();
}

/**
 * Who made each piece, and the creator and professional cards that sit among
 * the content (HOME-05, H9 and H10).
 *
 * Candidates for a card are decided here and nowhere else, as an ordered list
 * per kind; the interleaving picks by slot number, so page 2 never repeats a
 * card from page 1.
 */
@Injectable()
export class FeedCardsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wawuId: WawuIdClient,
    private readonly storage: StorageService,
  ) {}

  /** Name, avatar and ticks for a set of creators, in two reads. */
  async creatorsFor(ids: string[]): Promise<Map<string, FeedCreator>> {
    const unique = [...new Set(ids)];
    const out = new Map<string, FeedCreator>();
    if (unique.length === 0) return out;
    const [profiles, identities] = await Promise.all([
      this.prisma.userProfile.findMany({
        where: { wawuUserId: { in: unique } },
        select: {
          wawuUserId: true,
          handle: true,
          avatarUrl: true,
          creatorVerifiedAt: true,
          creatorVerifiedUntil: true,
          professionalVerifiedAt: true,
          professionalVerifiedUntil: true,
        },
      }),
      this.wawuId.lookupPublicIdentities(unique),
    ]);
    const byId = new Map(profiles.map((p) => [p.wawuUserId, p]));
    for (const id of unique) {
      const p = byId.get(id);
      const name = fullName(identities.get(id));
      out.set(id, {
        wawuId: id,
        displayName: name || p?.handle || null,
        handle: p?.handle ?? null,
        avatarUrl: await this.storage.freshUrlFor(p?.avatarUrl ?? null),
        verification: deriveVerificationState({
          creatorVerifiedAt: p?.creatorVerifiedAt ?? null,
          creatorVerifiedUntil: p?.creatorVerifiedUntil ?? null,
          professionalVerifiedAt: p?.professionalVerifiedAt ?? null,
          professionalVerifiedUntil: p?.professionalVerifiedUntil ?? null,
        }),
      });
    }
    return out;
  }

  /** Everyone the viewer blocked, or who blocked the viewer. */
  private async blockedEitherWay(viewerWawuId: string): Promise<Set<string>> {
    const rows = await this.prisma.blockedAccount.findMany({
      where: {
        OR: [{ userWawuId: viewerWawuId }, { blockedWawuId: viewerWawuId }],
      },
      select: { userWawuId: true, blockedWawuId: true },
    });
    const out = new Set<string>();
    for (const r of rows) {
      out.add(r.userWawuId === viewerWawuId ? r.blockedWawuId : r.userWawuId);
    }
    return out;
  }

  /**
   * Creators worth suggesting, best first: a creator account with at least one
   * live piece (something to show), not the viewer, not already followed, not
   * blocked either way. Ordered by followers, then id, so the order is stable.
   */
  async creatorCandidates(viewerWawuId: string): Promise<string[]> {
    const live = await this.prisma.contentPiece.groupBy({
      by: ['creatorWawuId'],
      where: { status: 'live' },
      _count: { _all: true },
    });
    const [followed, blocked] = await Promise.all([
      this.prisma.followRelationship.findMany({
        where: { followerWawuId: viewerWawuId },
        select: { followingWawuId: true },
      }),
      this.blockedEitherWay(viewerWawuId),
    ]);
    const skip = new Set([
      viewerWawuId,
      ...followed.map((f) => f.followingWawuId),
      ...blocked,
    ]);
    const eligible = live
      .map((l) => l.creatorWawuId)
      .filter((id) => !skip.has(id));
    if (eligible.length === 0) return [];
    const [creators, followerCounts] = await Promise.all([
      this.prisma.userProfile.findMany({
        where: { wawuUserId: { in: eligible }, accountType: 'creator' },
        select: { wawuUserId: true },
      }),
      this.prisma.followRelationship.groupBy({
        by: ['followingWawuId'],
        where: { followingWawuId: { in: eligible } },
        _count: { _all: true },
      }),
    ]);
    const count = new Map(
      followerCounts.map((f) => [f.followingWawuId, f._count._all]),
    );
    return creators
      .map((c) => c.wawuUserId)
      .sort(
        (a, b) =>
          (count.get(b) ?? 0) - (count.get(a) ?? 0) || a.localeCompare(b),
      );
  }

  /**
   * Professionals worth suggesting, best first: approved and listed, able to
   * be messaged (paid messages on, with a price), not the viewer, not blocked
   * either way. One listing per person (their best). Ordered by review count,
   * then rating, then id.
   */
  async professionalCandidates(viewerWawuId: string): Promise<string[]> {
    const blocked = await this.blockedEitherWay(viewerWawuId);
    const listings = await this.prisma.professionalProfile.findMany({
      where: {
        status: 'approved',
        listed: true,
        wawuUserId: { not: viewerWawuId, notIn: [...blocked] },
      },
      select: { id: true, wawuUserId: true },
    });
    if (listings.length === 0) return [];
    const [states, ratings] = await Promise.all([
      this.prisma.creatorState.findMany({
        where: {
          wawuUserId: { in: listings.map((l) => l.wawuUserId) },
          dmEnabled: true,
          dmPrice: { gt: 0 },
        },
        select: { wawuUserId: true },
      }),
      this.prisma.professionalReview.groupBy({
        by: ['professionalId'],
        where: { professionalId: { in: listings.map((l) => l.id) } },
        _avg: { stars: true },
        _count: { _all: true },
      }),
    ]);
    const messageable = new Set(states.map((s) => s.wawuUserId));
    const rating = new Map(
      ratings.map((r) => [
        r.professionalId,
        { avg: r._avg.stars ?? 0, count: r._count._all },
      ]),
    );
    const rank = (id: string) => rating.get(id) ?? { avg: 0, count: 0 };
    const ordered = listings
      .filter((l) => messageable.has(l.wawuUserId))
      .sort(
        (a, b) =>
          rank(b.id).count - rank(a.id).count ||
          rank(b.id).avg - rank(a.id).avg ||
          a.id.localeCompare(b.id),
      );
    const seen = new Set<string>();
    const out: string[] = [];
    for (const l of ordered) {
      if (seen.has(l.wawuUserId)) continue;
      seen.add(l.wawuUserId);
      out.push(l.id);
    }
    return out;
  }

  /** H9 cards for these creators, in the order given; unnamed ones dropped. */
  async creatorCards(
    viewerWawuId: string,
    ids: string[],
  ): Promise<Map<string, CreatorCard>> {
    const out = new Map<string, CreatorCard>();
    if (ids.length === 0) return out;
    const [creators, profiles, followers, live, ratings, viewerFollows] =
      await Promise.all([
        this.creatorsFor(ids),
        this.prisma.userProfile.findMany({
          where: { wawuUserId: { in: ids } },
          select: { wawuUserId: true, headline: true, coverUrl: true },
        }),
        this.prisma.followRelationship.groupBy({
          by: ['followingWawuId'],
          where: { followingWawuId: { in: ids } },
          _count: { _all: true },
        }),
        this.prisma.contentPiece.groupBy({
          by: ['creatorWawuId'],
          where: { creatorWawuId: { in: ids }, status: 'live' },
          _count: { _all: true },
        }),
        this.prisma.contentPiece.groupBy({
          by: ['creatorWawuId'],
          where: {
            creatorWawuId: { in: ids },
            status: 'live',
            ratingPct: { not: null },
          },
          _avg: { ratingPct: true },
        }),
        this.prisma.followRelationship.findMany({
          where: { followerWawuId: viewerWawuId },
          select: { followingWawuId: true },
        }),
      ]);
    const profileBy = new Map(profiles.map((p) => [p.wawuUserId, p]));
    const followersBy = new Map(
      followers.map((f) => [f.followingWawuId, f._count._all]),
    );
    const postsBy = new Map(live.map((l) => [l.creatorWawuId, l._count._all]));
    const ratingBy = new Map(
      ratings.map((r) => [r.creatorWawuId, r._avg.ratingPct]),
    );

    // People the viewer follows who also follow each creator.
    const viewerFollowees = viewerFollows.map((f) => f.followingWawuId);
    const mutualEdges = viewerFollowees.length
      ? await this.prisma.followRelationship.findMany({
          where: {
            followingWawuId: { in: ids },
            followerWawuId: { in: viewerFollowees },
          },
          orderBy: [{ createdAt: 'desc' }, { followerWawuId: 'asc' }],
          select: { followingWawuId: true, followerWawuId: true },
        })
      : [];
    const mutualBy = new Map<string, string[]>();
    for (const e of mutualEdges) {
      const list = mutualBy.get(e.followingWawuId) ?? [];
      list.push(e.followerWawuId);
      mutualBy.set(e.followingWawuId, list);
    }
    const shownMutuals = [
      ...new Set(
        [...mutualBy.values()].flatMap((l) => l.slice(0, CARD_KNOWN_FOLLOWERS)),
      ),
    ];
    const mutualPeople = await this.creatorsFor(shownMutuals);

    const works = await this.worksFor(viewerWawuId, ids);

    for (const id of ids) {
      const who = creators.get(id);
      // Nobody can tell an unnamed account apart from another; not offered.
      if (!who || !who.displayName) continue;
      const profile = profileBy.get(id);
      const mutuals = mutualBy.get(id) ?? [];
      out.set(id, {
        wawuId: id,
        displayName: who.displayName,
        handle: who.handle,
        headline: profile?.headline ?? null,
        avatarUrl: who.avatarUrl,
        coverUrl: await this.storage.freshUrlFor(profile?.coverUrl ?? null),
        verification: who.verification,
        followers: followersBy.get(id) ?? 0,
        posts: postsBy.get(id) ?? 0,
        rating: roundToOneDecimal(
          ratingBy.get(id) == null ? null : (ratingBy.get(id) as number) / 20,
        ),
        knownFollowers: {
          count: mutuals.length,
          people: mutuals.slice(0, CARD_KNOWN_FOLLOWERS).map((m) => ({
            wawuId: m,
            displayName: mutualPeople.get(m)?.displayName ?? null,
            avatarUrl: mutualPeople.get(m)?.avatarUrl ?? null,
          })),
        },
        works: works.get(id) ?? [],
        followsCreator: false,
      });
    }
    return out;
  }

  /** The newest live pieces of each creator, for the card's strip. */
  private async worksFor(
    viewerWawuId: string,
    creatorIds: string[],
  ): Promise<Map<string, CardWork[]>> {
    const perCreator = await Promise.all(
      creatorIds.map((creatorWawuId) =>
        this.prisma.contentPiece.findMany({
          where: { creatorWawuId, status: 'live' },
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          take: CARD_WORKS,
        }),
      ),
    );
    const pieces = perCreator.flat();
    const ids = pieces.map((p) => p.id);
    const [bought, frames] = ids.length
      ? await Promise.all([
          this.prisma.purchase.findMany({
            where: {
              contentId: { in: ids },
              buyerWawuId: viewerWawuId,
              type: 'content',
              status: 'completed',
            },
            select: { contentId: true },
          }),
          this.prisma.contentFrame.groupBy({
            by: ['contentId'],
            where: { contentId: { in: ids } },
            _count: { _all: true },
          }),
        ])
      : [[], []];
    const boughtSet = new Set(bought.map((b) => b.contentId));
    const frameBy = new Map(frames.map((f) => [f.contentId, f._count._all]));
    const out = new Map<string, CardWork[]>();
    for (const piece of pieces) {
      const list = out.get(piece.creatorWawuId) ?? [];
      list.push({
        id: piece.id,
        contentType: piece.contentType,
        accessType: piece.accessType,
        price: piece.price,
        locked: piece.accessType === 'paid' && !boughtSet.has(piece.id),
        title: piece.title,
        thumbnailUrl: await this.storage.freshUrlFor(piece.previewAssetUrl),
        durationLabel: piece.durationLabel,
        pageCount: piece.pageCount,
        frameCount: frameBy.get(piece.id) ?? 0,
        views: piece.views,
      });
      out.set(piece.creatorWawuId, list);
    }
    return out;
  }

  /** H10 cards for these listing ids; unnamed people dropped. */
  async professionalCards(
    listingIds: string[],
  ): Promise<Map<string, ProfessionalCard>> {
    const out = new Map<string, ProfessionalCard>();
    if (listingIds.length === 0) return out;
    const listings = await this.prisma.professionalProfile.findMany({
      where: { id: { in: listingIds } },
    });
    const people = listings.map((l) => l.wawuUserId);
    const [creators, profiles, states, ratings] = await Promise.all([
      this.creatorsFor(people),
      this.prisma.userProfile.findMany({
        where: { wawuUserId: { in: people } },
        select: { wawuUserId: true, coverUrl: true },
      }),
      this.prisma.creatorState.findMany({
        where: { wawuUserId: { in: people } },
        select: { wawuUserId: true, dmPrice: true, dmResponseHours: true },
      }),
      this.prisma.professionalReview.groupBy({
        by: ['professionalId'],
        where: { professionalId: { in: listingIds } },
        _avg: { stars: true },
        _count: { _all: true },
      }),
    ]);
    const coverBy = new Map(profiles.map((p) => [p.wawuUserId, p.coverUrl]));
    const stateBy = new Map(states.map((s) => [s.wawuUserId, s]));
    const ratingBy = new Map(
      ratings.map((r) => [
        r.professionalId,
        { avg: r._avg.stars, count: r._count._all },
      ]),
    );
    for (const l of listings) {
      const who = creators.get(l.wawuUserId);
      const state = stateBy.get(l.wawuUserId);
      if (!who || !who.displayName || !state?.dmPrice) continue;
      out.set(l.id, {
        id: l.id,
        wawuId: l.wawuUserId,
        displayName: who.displayName,
        handle: who.handle,
        headline: l.headline,
        avatarUrl: who.avatarUrl,
        coverUrl: await this.storage.freshUrlFor(
          coverBy.get(l.wawuUserId) ?? null,
        ),
        verification: who.verification,
        category: l.category,
        services: l.services,
        ratingAvg: roundToOneDecimal(ratingBy.get(l.id)?.avg ?? null),
        reviewCount: ratingBy.get(l.id)?.count ?? 0,
        dmPrice: state.dmPrice,
        dmResponseHours: state.dmResponseHours,
      });
    }
    return out;
  }
}
