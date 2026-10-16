import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  POPULAR_CANDIDATES_PER_PAGE,
  POPULAR_MAX_PAGES,
  POPULAR_MAX_PROBES,
  POPULAR_MIN_PEOPLE,
  POPULAR_SEARCHES_SHOWN,
  POPULAR_WINDOW_DAYS,
  RECENT_SEARCHES_KEPT,
  RECENT_SEARCHES_SHOWN,
} from './search-history.config';
import { whyNotPopular } from './popular-search-text';
import { communityMatch, contentMatch, creatorMatch } from './search-matchers';
import {
  refuseUnsearchableQuery,
  UNSEARCHABLE_QUERY_MESSAGE,
} from './searchable-query';

/** A list of search texts, newest or most searched first. */
export interface SearchTextList {
  items: string[];
}

/** DELETE /search/recent: how many of the person's recent searches went. */
export interface ClearedSearches {
  cleared: number;
}

/** The text as shown (spaces tidied) and as compared (also lowercased). */
export interface NormalisedSearch {
  query: string;
  queryKey: string;
}

/**
 * Trim, make every run of white space one space, and lowercase for the key.
 * "Tax  Filing " and "tax filing" are one search; the person's own spelling of
 * the newest one is what they see again.
 */
export function normaliseSearch(raw: string): NormalisedSearch {
  refuseUnsearchableQuery(raw);
  const query = raw.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (query === '') throw new BadRequestException(UNSEARCHABLE_QUERY_MESSAGE);
  return { query, queryKey: query.toLowerCase() };
}

/**
 * Text that is never offered to everyone as a popular search, however many
 * accounts typed it: a phone number, an email address in any spelling, a link
 * or domain, or text with an invisible character in it. The rules and the
 * forms they catch are in popular-search-text.ts.
 */
export function looksPersonal(queryKey: string): boolean {
  return whyNotPopular(queryKey) !== null;
}

/**
 * EXPLORE-05: what a person searched (Recent, Clear) and what many people
 * searched (People are searching). One table, `SearchHistory`, serves both: a
 * search is popular when enough different people have it in their history
 * lately, so there is no second count that could outlive a Clear.
 */
@Injectable()
export class SearchHistoryService {
  constructor(private readonly prisma: PrismaService) {}

  /** The caller's newest searches, for the Search landing. */
  async recent(userWawuId: string): Promise<string[]> {
    const rows = await this.prisma.searchHistory.findMany({
      where: { userWawuId },
      orderBy: [{ searchedAt: 'desc' }, { queryKey: 'asc' }],
      take: RECENT_SEARCHES_SHOWN,
      select: { query: true },
    });
    return rows.map((r) => r.query);
  }

  /**
   * Remember a search. The same text again moves to the top; a person keeps
   * their newest RECENT_SEARCHES_KEPT. Answers the list as it now stands.
   */
  async record(userWawuId: string, raw: string): Promise<SearchTextList> {
    const { query, queryKey } = normaliseSearch(raw);
    await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      await tx.searchHistory.upsert({
        where: { userWawuId_queryKey: { userWawuId, queryKey } },
        create: { userWawuId, queryKey, query, searchedAt: now },
        update: { query, searchedAt: now },
      });
      const beyond = await tx.searchHistory.findMany({
        where: { userWawuId },
        orderBy: [{ searchedAt: 'desc' }, { queryKey: 'asc' }],
        skip: RECENT_SEARCHES_KEPT,
        select: { queryKey: true },
      });
      if (beyond.length > 0) {
        await tx.searchHistory.deleteMany({
          where: {
            userWawuId,
            queryKey: { in: beyond.map((b) => b.queryKey) },
          },
        });
      }
    });
    return { items: await this.recent(userWawuId) };
  }

  /** Clear: every recent search of the caller's, and nobody else's. */
  async clear(userWawuId: string): Promise<ClearedSearches> {
    const { count } = await this.prisma.searchHistory.deleteMany({
      where: { userWawuId },
    });
    return { cleared: count };
  }

  /**
   * Searches that at least POPULAR_MIN_PEOPLE different people made in the
   * last POPULAR_WINDOW_DAYS, most people first, then the most recent. Each is
   * shown as its newest spelling. Empty until enough people have searched:
   * nothing stands in for a search nobody made.
   *
   * A search made only by accounts whose deletion is scheduled does not count
   * (and a deleted account's search is not counted toward the people), so a
   * text leaves the list the moment enough of its people ask to leave. Then a
   * text is offered only if it may be (popular-search-text.ts) and only if
   * GET /search would show a signed-out visitor at least one result for it,
   * so a sentence, a private person's name or spam typed by three accounts
   * never reaches the landing.
   */
  async popular(now: Date = new Date()): Promise<SearchTextList> {
    const since = new Date(now.getTime() - POPULAR_WINDOW_DAYS * 86_400_000);
    const keys: string[] = [];
    let probes = 0;
    for (
      let page = 0;
      page < POPULAR_MAX_PAGES && keys.length < POPULAR_SEARCHES_SHOWN;
      page++
    ) {
      const candidates = await this.popularCandidates(
        since,
        page * POPULAR_CANDIDATES_PER_PAGE,
        POPULAR_CANDIDATES_PER_PAGE,
      );
      for (const key of candidates) {
        if (keys.length >= POPULAR_SEARCHES_SHOWN) break;
        if (whyNotPopular(key) !== null) continue;
        if (probes >= POPULAR_MAX_PROBES) break;
        probes += 1;
        if (await this.hasPublicResult(key)) keys.push(key);
      }
      if (
        candidates.length < POPULAR_CANDIDATES_PER_PAGE ||
        probes >= POPULAR_MAX_PROBES
      )
        break;
    }
    if (keys.length === 0) return { items: [] };

    const spellings = await this.prisma.$queryRaw<
      { queryKey: string; query: string }[]
    >`
      SELECT DISTINCT ON (h."queryKey") h."queryKey" AS "queryKey", h."query" AS "query"
      FROM "SearchHistory" h
      WHERE h."queryKey" = ANY(${keys}::text[])
        AND h."searchedAt" >= ${since}
        AND NOT EXISTS (
          SELECT 1 FROM "PushStoppedAccount" p WHERE p."userWawuId" = h."userWawuId")
      ORDER BY h."queryKey", h."searchedAt" DESC`;
    const newest = new Map(spellings.map((s) => [s.queryKey, s.query]));
    return { items: keys.map((k) => newest.get(k) ?? k) };
  }

  /**
   * The next page of search texts that enough people made lately, most people
   * first. Rows are one per person and text, so a count of rows is a count of
   * people. `PushStoppedAccount` is the mark `DELETE /account` leaves on an
   * account whose deletion is scheduled (on main, and on SETTINGS-06 once the
   * deletion is in force; a cancel removes it, the purge deletes it with the
   * account's data), so those accounts are left out of the count.
   */
  private async popularCandidates(
    since: Date,
    offset: number,
    size: number,
  ): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ queryKey: string }[]>`
      SELECT h."queryKey" AS "queryKey"
      FROM "SearchHistory" h
      WHERE h."searchedAt" >= ${since}
        AND NOT EXISTS (
          SELECT 1 FROM "PushStoppedAccount" p WHERE p."userWawuId" = h."userWawuId")
      GROUP BY h."queryKey"
      HAVING COUNT(*) >= ${POPULAR_MIN_PEOPLE}
      ORDER BY COUNT(*) DESC, MAX(h."searchedAt") DESC, h."queryKey" ASC
      LIMIT ${size} OFFSET ${offset}`;
    return rows.map((r) => r.queryKey);
  }

  /**
   * Whether GET /search, called with no token, answers this text with at least
   * one content piece, creator or community. It reads the same three clauses
   * GET /search reads (search-matchers.ts) and stops at the first hit; a
   * creator counts only with a `CreatorState` row, as the list does.
   */
  async hasPublicResult(q: string): Promise<boolean> {
    const hidden: string[] = [];
    const content = await this.prisma.contentPiece.findFirst({
      where: contentMatch(q, hidden),
      select: { id: true },
    });
    if (content) return true;
    const community = await this.prisma.community.findFirst({
      where: communityMatch(q, hidden),
      select: { id: true },
    });
    if (community) return true;
    // GET /search lists a matching creator only with a CreatorState row, so
    // at least one matching profile must have one. The first 200 matching
    // profiles are looked at, far more than any text that finds creators has.
    const profiles = await this.prisma.userProfile.findMany({
      where: creatorMatch(q, hidden),
      select: { wawuUserId: true },
      take: 200,
    });
    if (profiles.length === 0) return false;
    const state = await this.prisma.creatorState.findFirst({
      where: { wawuUserId: { in: profiles.map((p) => p.wawuUserId) } },
      select: { wawuUserId: true },
    });
    return state !== null;
  }
}
