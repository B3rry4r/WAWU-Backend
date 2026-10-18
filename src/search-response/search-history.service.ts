import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { PlanSettingsService } from '../plan-settings/plan-settings.service';
import {
  POPULAR_CACHE_SECONDS,
  POPULAR_MIN_PEOPLE,
  POPULAR_COMMUNITY_MIN_MEMBERS_KEY,
  POPULAR_SEARCHES_SHOWN,
  POPULAR_WINDOW_DAYS,
  RECENT_SEARCHES_KEPT,
  RECENT_SEARCHES_SHOWN,
} from './search-history.config';
import { foldSql, isShowableName, showableNameSql } from './popular-name';
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
 * EXPLORE-05: what a person searched (Recent, Clear) and what many people
 * searched (People are searching). One table, `SearchHistory`, serves both: a
 * search is popular when enough different people have it in their history
 * lately, so there is no second count that could outlive a Clear.
 */
@Injectable()
export class SearchHistoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: PlanSettingsService,
  ) {}

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
      // One person's searches are written one at a time, so the cap below is read after the others have landed: with many at
      // once each saw the old rows only and the list grew past it (same lock as PushTokenService.register; SWEEP-APP-4, EXPLORE-05 V1-4).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'search-recent:' + userWawuId}, 0))`;
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
   * "People are searching": the names of public things that at least
   * POPULAR_MIN_PEOPLE different people searched in the last
   * POPULAR_WINDOW_DAYS, most people first, then the most recent. Empty until
   * enough people have searched: nothing stands in for a search nobody made.
   *
   * An entry is the NAME of something a signed-out visitor can find today (a
   * content title, a creator's handle with a creator state, a community name
   * once the community has the admin setting `popular_community_min_members`
   * members (R-57, read live, HOME-17), a
   * category name) that the searched text equals once both are folded
   * (popular-name.ts), and the name has to pass the character rule there. The
   * text shown is that name, never a searcher's spelling. One query ranks
   * them, and only texts that pass the equality count, so texts typed only to
   * crowd the list cannot push a real entry off it. A search made by an
   * account whose deletion is scheduled does not count (a deleted account's
   * search is not counted toward the people).
   *
   * The answer is kept in this process for POPULAR_CACHE_SECONDS: the route is
   * public, every call would otherwise scan the names, and a deletion can show
   * for up to that long. Calls that arrive together share one query.
   */
  popular(now: Date = new Date()): Promise<SearchTextList> {
    const at = now.getTime();
    // Read live (HOME-17): a kept answer built with another figure is stale
    // the moment an admin edits it, so an edit shows on the next call.
    const minMembers = this.settings.number(POPULAR_COMMUNITY_MIN_MEMBERS_KEY);
    const held = this.popularCache;
    const fresh =
      held !== null &&
      held.minMembers === minMembers &&
      at - held.at >= 0 &&
      at - held.at < POPULAR_CACHE_SECONDS * 1000;
    if (held !== null && fresh) return held.answer.then(copyOf);
    const entry = { at, minMembers, answer: this.rankPopular(now, minMembers) };
    this.popularCache = entry;
    // A failed query is not kept: the next call asks again.
    entry.answer.catch(() => {
      if (this.popularCache === entry) this.popularCache = null;
    });
    return entry.answer.then(copyOf);
  }

  /** Forget the kept answer; the next call to popular() asks the database. */
  resetPopularCache(): void {
    this.popularCache = null;
  }

  private popularCache: {
    at: number;
    minMembers: number;
    answer: Promise<SearchTextList>;
  } | null = null;

  /**
   * The one query. `keys` are the distinct texts searched in the window, each
   * with its folded form; `names` are the shown-able names of public things,
   * folded, one per folded text (a category before a community before a
   * creator handle before a title, then the lower name); the join is equality
   * of the folded forms. A community is a name only while it has enough
   * members (the same count as its row's memberCount: joined, host not
   * included); another public thing with the same name still is one. The
   * members are counted only for the rooms whose folded name is one of the
   * searched texts (`rooms`, kept as its own step so the count runs after the
   * match and not for every room: SWEEP-APP-5, EXPLORE-06 L1). People
   * are counted over every spelling that folds to the same name, one count per
   * person. `PushStoppedAccount` is the mark
   * `DELETE /account` leaves on an account whose deletion is scheduled (a
   * cancel removes it, the purge deletes it with the account's data).
   */
  private async rankPopular(
    now: Date,
    minMembers: number,
  ): Promise<SearchTextList> {
    const since = new Date(now.getTime() - POPULAR_WINDOW_DAYS * 86_400_000);
    const col = (ref: string) => Prisma.raw(ref);
    const rows = await this.prisma.$queryRaw<{ shown: string }[]>(Prisma.sql`
      WITH keys AS (
        SELECT h."queryKey" AS qk, ${foldSql(col('h."queryKey"'))} AS fk
        FROM "SearchHistory" h
        WHERE h."searchedAt" >= ${since}
          AND NOT EXISTS (
            SELECT 1 FROM "PushStoppedAccount" p WHERE p."userWawuId" = h."userWawuId")
        GROUP BY h."queryKey"
      ),
      rooms AS MATERIALIZED (
        SELECT m.id AS id, m.name AS name, ${foldSql(col('m.name'))} AS fk
        FROM "Community" m
        WHERE ${showableNameSql(col('m.name'))}
          AND ${foldSql(col('m.name'))} IN (SELECT fk FROM keys)
      ),
      names AS (
        SELECT DISTINCT ON (u.fk) u.fk AS fk, u.shown AS shown
        FROM (
          SELECT ${foldSql(col('c.category'))} AS fk, c.category AS shown, 1 AS pri
          FROM "ContentPiece" c
          WHERE c.status = 'live' AND ${showableNameSql(col('c.category'))}
          UNION ALL
          SELECT m.fk, m.name, 2
          FROM rooms m
          WHERE (SELECT COUNT(*) FROM "CommunityMembership" cm
                 WHERE cm."communityId" = m.id AND cm.status = 'joined') >= ${minMembers}
          UNION ALL
          SELECT ${foldSql(col('p.handle'))}, p.handle, 3
          FROM "UserProfile" p
          WHERE p."accountType" = 'creator'
            AND p.handle IS NOT NULL
            AND ${showableNameSql(col('p.handle'))}
            AND EXISTS (SELECT 1 FROM "CreatorState" s WHERE s."wawuUserId" = p."wawuUserId")
          UNION ALL
          SELECT ${foldSql(col('t.title'))}, t.title, 4
          FROM "ContentPiece" t
          WHERE t.status = 'live' AND ${showableNameSql(col('t.title'))}
        ) u
        ORDER BY u.fk, u.pri, u.shown
      ),
      ranked AS (
        SELECT n.shown AS shown,
               COUNT(DISTINCT h."userWawuId") AS people,
               MAX(h."searchedAt") AS latest
        FROM keys k
        JOIN names n ON n.fk = k.fk
        JOIN "SearchHistory" h ON h."queryKey" = k.qk
        WHERE h."searchedAt" >= ${since}
          AND NOT EXISTS (
            SELECT 1 FROM "PushStoppedAccount" p WHERE p."userWawuId" = h."userWawuId")
        GROUP BY n.fk, n.shown
        HAVING COUNT(DISTINCT h."userWawuId") >= ${POPULAR_MIN_PEOPLE}
      )
      SELECT btrim(regexp_replace(shown, ' +', ' ', 'g')) AS shown
      FROM ranked
      ORDER BY people DESC, latest DESC, shown ASC
      LIMIT ${POPULAR_SEARCHES_SHOWN}`);
    // The database applied the character rule; the same rule here, as a belt.
    return { items: rows.map((r) => r.shown).filter(isShowableName) };
  }
}

function copyOf(list: SearchTextList): SearchTextList {
  return { items: [...list.items] };
}
