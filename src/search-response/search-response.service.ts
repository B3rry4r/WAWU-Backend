import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { deriveVerificationState } from '../common/verification/verification-state';
import {
  AccountType,
  ContentStatus,
  PurchaseType,
  TransactionStatus,
} from '../../generated/prisma/enums';
import type {
  ContentPieceModel,
  UserProfileModel,
} from '../../generated/prisma/models';
import type {
  ContentPieceResponse,
  CreatorProfile,
  SearchResults,
  SearchSuggestions,
  ClosestSearchResult,
} from '../common/types';
import type { SearchTab } from './dto/search-query.dto';

/** Result cap per array — search is discovery, not pagination (registry.json gives SearchResponse no page/perPage params). */
const RESULT_LIMIT = 20;
const SUGGESTION_LIMIT = 5;
const CLOSEST_LIMIT = 10;

/**
 * SearchResponse (registry.json) has NO Prisma model of its own (fields: []
 * — see prisma/schema.prisma header comment) — every field here is a live
 * read across ContentPiece, UserProfile, and (nominally) Community. This
 * service is a pure read/aggregation, never a writer — mirrors
 * LearnEntitlementService's own doc-comment precedent for a modelless
 * resource.
 *
 * Substring matching uses Postgres ILIKE via Prisma's `contains` +
 * `mode: 'insensitive'` (task brief: no full-text-search infra needed).
 * `pg_trgm` is NOT enabled anywhere in prisma/migrations (confirmed: grep
 * turned up nothing, and adding an extension is a schema/migration change
 * outside this resource's scope per task brief § SCOPE — never touch
 * prisma/schema.prisma) — GET /search/closest's "fuzzy" fallback is
 * therefore an honest broadened-ILIKE tokenization, documented on
 * `closest()` below, not real trigram similarity.
 */
@Injectable()
export class SearchResponseService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------
  // GET /search
  // ---------------------------------------------------------------------

  /**
   * `tab` narrows which array(s) get populated, but the envelope shape
   * never changes — when `tab=content`, `creators`/`communities` are still
   * present, just empty arrays (task brief's explicit documented choice,
   * so frontend code never has to branch on which keys exist).
   */
  async search(
    q: string,
    tab: SearchTab,
    requesterWawuId: string | undefined,
  ): Promise<SearchResults> {
    const wantContent = tab === 'all' || tab === 'content';
    const wantCreators = tab === 'all' || tab === 'creators';

    const [content, creators] = await Promise.all([
      wantContent
        ? this.searchContent(q, requesterWawuId)
        : Promise.resolve([]),
      wantCreators ? this.searchCreators(q) : Promise.resolve([]),
    ]);

    return {
      content,
      creators,
      // JUDGMENT (task brief, loud call-out): Community is Wave 3 and
      // src/community does not exist in this checkout yet (confirmed: `ls
      // src/community` fails). This is NOT a stub awaiting a runtime
      // trigger — it's a dependency that genuinely does not exist yet to
      // build a real predicate against (no CommunityService/DTO/test
      // conventions to follow, no confidence about what "searchable" means
      // for a Community once Wave 3 lands, e.g. should archived/private
      // communities match?). Returns [] unconditionally so /search's
      // envelope shape is contract-correct today without guessing Wave 3's
      // own design. Revisit once src/community exists — see final report.
      communities: [],
    };
  }

  private async searchContent(
    q: string,
    requesterWawuId: string | undefined,
  ): Promise<ContentPieceResponse[]> {
    const items = await this.prisma.contentPiece.findMany({
      where: {
        status: ContentStatus.live,
        OR: [
          { title: { contains: q, mode: 'insensitive' } },
          { description: { contains: q, mode: 'insensitive' } },
          { category: { contains: q, mode: 'insensitive' } },
        ],
      },
      orderBy: { views: 'desc' },
      take: RESULT_LIMIT,
    });
    return this.toContentResponses(items, requesterWawuId);
  }

  private async searchCreators(q: string): Promise<CreatorProfile[]> {
    const profiles = await this.prisma.userProfile.findMany({
      where: {
        accountType: AccountType.creator,
        OR: [
          { handle: { contains: q, mode: 'insensitive' } },
          { bio: { contains: q, mode: 'insensitive' } },
        ],
      },
      select: { wawuUserId: true },
    });
    // Relevance heuristic: rank matches by EvgScore (task brief's own
    // suggestion for suggestedCreators, reused here — no other ranking
    // signal is contracted for this endpoint).
    const orderedIds = await this.rankByEvgScore(
      profiles.map((p) => p.wawuUserId),
    );
    return this.buildCreatorProfiles(orderedIds);
  }

  // ---------------------------------------------------------------------
  // GET /search/suggestions
  // ---------------------------------------------------------------------

  /**
   * No `requesterWawuId` param: recentSearches is always `[]` regardless of
   * auth state (see the doc comment on the return below) so there is
   * nothing yet to key off the caller. The controller still resolves
   * `user?.sub` from an optional bearer token — this signature intentionally
   * doesn't accept it today; wire it back in once search-history
   * persistence exists.
   */
  async suggestions(): Promise<SearchSuggestions> {
    const [popularSearches, suggestedCreatorIds] = await Promise.all([
      this.popularSearches(),
      this.topCreatorIdsByEvgScore(SUGGESTION_LIMIT),
    ]);
    const suggestedCreators =
      await this.buildCreatorProfiles(suggestedCreatorIds);

    return {
      // JUDGMENT (task brief, documented gap): prisma/schema.prisma has no
      // per-user search-history table (confirmed: grep `^model ` above —
      // no SearchHistory/RecentSearch model exists), and this resource has
      // no Prisma model of its own to add one to (out of scope per task
      // brief § SCOPE — never touch prisma/schema.prisma). recentSearches
      // is therefore [] for every caller, authenticated or not, until a
      // future wave adds persistence. Not silently swallowed: flagged
      // loudly in the final report for the orchestrator.
      recentSearches: [],
      popularSearches,
      suggestedCreators,
    };
  }

  /**
   * JUDGMENT: no dedicated search-tracking table exists (task brief
   * anticipated this). Approximates "popular" with the same signal
   * ContentPiece already stores for its own feed ranking: top live content
   * by view count, reduced to just their titles (a search suggestion is a
   * query string a user might type, not a full content object).
   */
  private async popularSearches(): Promise<string[]> {
    const top = await this.prisma.contentPiece.findMany({
      where: { status: ContentStatus.live },
      orderBy: { views: 'desc' },
      take: SUGGESTION_LIMIT,
      select: { title: true },
    });
    return top.map((t) => t.title);
  }

  // ---------------------------------------------------------------------
  // GET /search/closest
  // ---------------------------------------------------------------------

  /**
   * Fuzzy no-results fallback. `pg_trgm` is not enabled in this database
   * (see class-level doc comment) and enabling it would mean a migration,
   * which is out of this resource's scope — so this broadens the match
   * instead of deepening it: split `q` into whitespace-separated tokens and
   * OR an ILIKE-contains across title/description/category for *each*
   * token individually, so e.g. "makeup tutoril" (typo) still surfaces
   * "10-Minute Owambe Makeup" via the "makeup" token even though the whole
   * phrase never substring-matches. Honest tradeoff, documented per task
   * brief: this is broader substring matching, not similarity ranking.
   */
  async closest(q: string): Promise<ClosestSearchResult> {
    const tokens = q
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    if (tokens.length === 0) {
      return { items: [] };
    }

    const items = await this.prisma.contentPiece.findMany({
      where: {
        status: ContentStatus.live,
        OR: tokens.flatMap((token) => [
          { title: { contains: token, mode: 'insensitive' as const } },
          { description: { contains: token, mode: 'insensitive' as const } },
          { category: { contains: token, mode: 'insensitive' as const } },
        ]),
      },
      orderBy: { views: 'desc' },
      take: CLOSEST_LIMIT,
    });

    return { items: await this.toContentResponses(items, undefined) };
  }

  // ---------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------

  /**
   * `fullAssetLocked`/`fullAssetUrl` derivation mirrors
   * ContentPieceService.toResponse/resolveUnlockedSet exactly (same
   * product rule: free content is never locked; paid content is locked
   * unless the requester owns it as creator or has a completed Purchase).
   * Duplicated locally rather than imported — ContentPieceService's
   * relevant methods are private, and importing another resource's
   * internals would violate this resource's own directory scope.
   */
  private async toContentResponses(
    items: ContentPieceModel[],
    requesterWawuId: string | undefined,
  ): Promise<ContentPieceResponse[]> {
    const unlockedSet = await this.resolveUnlockedSet(
      requesterWawuId,
      items.map((i) => i.id),
    );
    return items.map((item) => {
      const isFree = item.accessType === 'free';
      const locked = !isFree && !unlockedSet.has(item.id);
      return {
        ...item,
        fullAssetUrl: locked ? null : item.fullAssetUrl,
        fullAssetLocked: locked,
      };
    });
  }

  private async resolveUnlockedSet(
    requesterWawuId: string | undefined,
    contentIds: string[],
  ): Promise<Set<string>> {
    if (!requesterWawuId || contentIds.length === 0) return new Set();

    const [ownedAsCreator, completedPurchases] = await Promise.all([
      this.prisma.contentPiece.findMany({
        where: { id: { in: contentIds }, creatorWawuId: requesterWawuId },
        select: { id: true },
      }),
      this.prisma.purchase.findMany({
        where: {
          contentId: { in: contentIds },
          buyerWawuId: requesterWawuId,
          type: PurchaseType.content,
          status: TransactionStatus.completed,
        },
        select: { contentId: true },
      }),
    ]);

    const unlocked = new Set<string>();
    for (const row of ownedAsCreator) unlocked.add(row.id);
    for (const row of completedPurchases)
      if (row.contentId) unlocked.add(row.contentId);
    return unlocked;
  }

  private async rankByEvgScore(wawuUserIds: string[]): Promise<string[]> {
    if (wawuUserIds.length === 0) return [];
    const scores = await this.prisma.evgScore.findMany({
      where: { creatorWawuId: { in: wawuUserIds } },
      orderBy: { score: 'desc' },
      select: { creatorWawuId: true },
    });
    const scored = new Set(scores.map((s) => s.creatorWawuId));
    // Creators matched by the text search but with no EvgScore row yet
    // (score defaults to 0 — never recomputed) are appended in their
    // original order after every scored creator, so a real match is never
    // silently dropped just because scoring hasn't run for them.
    const unscored = wawuUserIds.filter((id) => !scored.has(id));
    return [...scores.map((s) => s.creatorWawuId), ...unscored];
  }

  private async topCreatorIdsByEvgScore(limit: number): Promise<string[]> {
    const top = await this.prisma.evgScore.findMany({
      orderBy: { score: 'desc' },
      take: limit,
      select: { creatorWawuId: true },
    });
    return top.map((t) => t.creatorWawuId);
  }

  /**
   * Builds the CreatorProfile aggregate for a batch of wawuUserIds, in the
   * given order. Mirrors UserProfileService.getPublicProfile's own
   * definition of "has a public creator profile" (requires a CreatorState
   * row — a `creator`-account-type UserProfile with no CreatorState yet,
   * e.g. pre-subscription, is silently excluded rather than surfaced with
   * a fabricated `tier`) — duplicated locally for the same directory-scope
   * reason as toContentResponses above, but batched (N ids in 5 queries)
   * instead of one-at-a-time, since search/suggestions returns lists.
   */
  private async buildCreatorProfiles(
    orderedWawuUserIds: string[],
  ): Promise<CreatorProfile[]> {
    const ids = [...new Set(orderedWawuUserIds)];
    if (ids.length === 0) return [];

    const [
      profiles,
      states,
      scores,
      contentCounts,
      followerCounts,
      followingCounts,
      communityCounts,
    ] = await Promise.all([
      this.prisma.userProfile.findMany({ where: { wawuUserId: { in: ids } } }),
      this.prisma.creatorState.findMany({ where: { wawuUserId: { in: ids } } }),
      this.prisma.evgScore.findMany({ where: { creatorWawuId: { in: ids } } }),
      this.prisma.contentPiece.groupBy({
        by: ['creatorWawuId'],
        where: { creatorWawuId: { in: ids }, status: ContentStatus.live },
        _count: { _all: true },
      }),
      this.prisma.followRelationship.groupBy({
        by: ['followingWawuId'],
        where: { followingWawuId: { in: ids } },
        _count: { _all: true },
      }),
      // The other direction of the same relation. Counted here for the same
      // reason the follower count is: a creator found through search must not
      // be described differently from the same creator opened directly.
      this.prisma.followRelationship.groupBy({
        by: ['followerWawuId'],
        where: { followerWawuId: { in: ids } },
        _count: { _all: true },
      }),
      this.prisma.community.groupBy({
        by: ['hostWawuId'],
        where: { hostWawuId: { in: ids } },
        _count: { _all: true },
      }),
    ]);

    const profileMap = new Map<string, UserProfileModel>(
      profiles.map((p) => [p.wawuUserId, p]),
    );
    const stateMap = new Map(states.map((s) => [s.wawuUserId, s]));
    const scoreMap = new Map(scores.map((s) => [s.creatorWawuId, s.score]));
    const contentCountMap = new Map(
      contentCounts.map((c) => [c.creatorWawuId, c._count._all]),
    );
    const followerCountMap = new Map(
      followerCounts.map((c) => [c.followingWawuId, c._count._all]),
    );
    const followingCountMap = new Map(
      followingCounts.map((c) => [c.followerWawuId, c._count._all]),
    );
    const communityCountMap = new Map(
      communityCounts.map((c) => [c.hostWawuId, c._count._all]),
    );

    const result: CreatorProfile[] = [];
    for (const id of orderedWawuUserIds) {
      if (result.some((r) => r.wawuUserId === id)) continue; // de-dupe, preserve first occurrence's rank
      const profile = profileMap.get(id);
      const state = stateMap.get(id);
      if (!profile || !state) continue;
      result.push({
        wawuUserId: profile.wawuUserId,
        // Derived from the same four columns, through the same function, as
        // the public profile. A creator found through search must not be
        // described differently from the same creator opened directly.
        verification: deriveVerificationState(profile),
        handle: profile.handle,
        bio: profile.bio,
        // Same omission as the public profile had: search returned every
        // creator without a face, so a results list was a column of initials.
        avatarUrl: profile.avatarUrl,
        coverUrl: profile.coverUrl,
        interests: profile.interests,
        instagramHandle: profile.instagramHandle,
        xHandle: profile.xHandle,
        tiktokHandle: profile.tiktokHandle,
        youtubeUrl: profile.youtubeUrl,
        facebookUrl: profile.facebookUrl,
        linkedinUrl: profile.linkedinUrl,
        whatsappHandle: profile.whatsappHandle,
        websiteUrl: profile.websiteUrl,
        company: profile.company,
        headline: profile.headline,
        /*
          EMPTY ON PURPOSE, AND THE ONE PLACE THAT IS TRUE.

          A search result is a card: a face, a name, a handle and a line of
          bio. Nothing on it draws an experience list, and filling this would
          mean one extra query per result page to populate something nobody
          renders. The full list is on the profile the card opens.

          It is `[]` rather than the field being optional because a shape that
          is sometimes absent is a shape every reader has to test for. This
          says "no roles to show here", which is exactly what a card means.
        */
        experience: [],
        // Same buyer-facing DM settings as the public-profile aggregate, so a
        // creator found through search is not described differently from the
        // same creator opened directly.
        dmEnabled: state.dmEnabled,
        dmPrice: state.dmPrice,
        dmResponseHours: state.dmResponseHours,
        evgScore: scoreMap.get(id) ?? 0,
        contentCount: contentCountMap.get(id) ?? 0,
        followerCount: followerCountMap.get(id) ?? 0,
        followingCount: followingCountMap.get(id) ?? 0,
        communityCount: communityCountMap.get(id) ?? 0,
      });
    }
    return result;
  }
}
