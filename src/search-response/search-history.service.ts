import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  POPULAR_MIN_PEOPLE,
  POPULAR_SEARCHES_SHOWN,
  POPULAR_WINDOW_DAYS,
  RECENT_SEARCHES_KEPT,
  RECENT_SEARCHES_SHOWN,
} from './search-history.config';
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
 * Text that looks like somebody's own details (an email address, a phone or
 * account number) is theirs to keep in Recent and is never offered to everyone
 * as a popular search, however many people typed it.
 */
export function looksPersonal(queryKey: string): boolean {
  return queryKey.includes('@') || /\d(?:[ -]?\d){8,}/.test(queryKey);
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
   */
  async popular(now: Date = new Date()): Promise<SearchTextList> {
    const since = new Date(now.getTime() - POPULAR_WINDOW_DAYS * 86_400_000);
    // Rows are one per person and text, so a count of rows is a count of people.
    const groups = await this.prisma.searchHistory.groupBy({
      by: ['queryKey'],
      where: { searchedAt: { gte: since } },
      having: { queryKey: { _count: { gte: POPULAR_MIN_PEOPLE } } },
      orderBy: [
        { _count: { queryKey: 'desc' } },
        { _max: { searchedAt: 'desc' } },
      ],
      // More than shown, so the texts left out as personal do not shorten the list.
      take: POPULAR_SEARCHES_SHOWN * 4,
    });
    const keys = groups
      .map((g) => g.queryKey)
      .filter((k) => !looksPersonal(k))
      .slice(0, POPULAR_SEARCHES_SHOWN);
    if (keys.length === 0) return { items: [] };

    const spellings = await this.prisma.searchHistory.findMany({
      where: { queryKey: { in: keys }, searchedAt: { gte: since } },
      orderBy: { searchedAt: 'desc' },
      select: { queryKey: true, query: true },
    });
    const newest = new Map<string, string>();
    for (const s of spellings)
      if (!newest.has(s.queryKey)) newest.set(s.queryKey, s.query);
    return { items: keys.map((k) => newest.get(k) ?? k) };
  }
}
