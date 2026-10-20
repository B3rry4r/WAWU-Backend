import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { foldSql, showableNameSql } from '../popular-name';
import { SearchResponseModule } from '../search-response.module';
import {
  normaliseSearch,
  SearchHistoryService,
} from '../search-history.service';
import { joinMembers } from './popular-members';

/**
 * SWEEP-APP-5, EXPLORE-06 L1. "People are searching" counted the members of
 * every room with a showable name, searched or not: on 20,000 rooms and
 * 200,000 joined rows one refresh took 1.0 to 1.4 s, against 0.4 s without.
 * The count now runs only for the rooms whose folded name is one of the
 * searched texts.
 *
 * Time is not a test, so this reads the plan: the one query the service asks
 * is captured, run again under EXPLAIN (ANALYZE), and the member count (the
 * scan of "CommunityMembership" under its aggregate) must have run once per
 * room whose name was searched, never once per room.
 *
 * Rows made here carry MARK (letters only) in their names, text and ids, so
 * the spec holds on a database other suites have used, and all go in afterAll.
 */
const MARK = 'swaexplainroom';
const HOST = '00000000-0000-4000-8000-000000000003';

type PlanNode = {
  'Node Type': string;
  'Relation Name'?: string;
  'Actual Loops'?: number;
  Plans?: PlanNode[];
};

/** Every loop count of every scan of `relation` in a plan. */
function loopsOf(node: PlanNode, relation: string): number[] {
  const own =
    node['Relation Name'] === relation && node['Actual Loops'] !== undefined
      ? [node['Actual Loops']]
      : [];
  return [...own, ...(node.Plans ?? []).flatMap((n) => loopsOf(n, relation))];
}

describe('GET /search/popular counts members only for searched rooms (SWEEP-APP-5, EXPLORE-06 L1)', () => {
  let prisma: PrismaService;
  let history: SearchHistoryService;
  const roomIds: string[] = [];
  const ROOMS = 40;
  const SEARCHED = 2;

  const name = (i: number) =>
    `${MARK} ${'abcdefghijklmnopqrstuvwxyzabcdefghijklmn'[i]}room`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        SearchResponseModule,
      ],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    history = moduleRef.get(SearchHistoryService);

    // Forty rooms with showable names and members, two of them searched.
    for (let i = 0; i < ROOMS; i += 1) {
      const room = await prisma.community.create({
        data: {
          name: name(i),
          hostWawuId: HOST,
          kind: 'open',
          description: 'x',
        },
      });
      roomIds.push(room.id);
      await joinMembers(prisma, room.id, MARK, 12);
    }
    for (let i = 0; i < SEARCHED; i += 1) {
      const n = normaliseSearch(name(i));
      await prisma.searchHistory.createMany({
        data: Array.from({ length: 25 }, (_, p) => ({
          userWawuId: `${MARK}-u${p}-${i}`,
          queryKey: n.queryKey,
          query: n.query,
          searchedAt: new Date(Date.now() - p * 1000),
        })),
      });
    }
  });

  afterAll(async () => {
    await prisma.searchHistory.deleteMany({
      where: { userWawuId: { startsWith: `${MARK}-` } },
    });
    await prisma.community.deleteMany({
      where: { OR: [{ id: { in: roomIds } }, { name: { startsWith: MARK } }] },
    });
    await prisma.$disconnect();
  });

  it('still names the searched rooms that have enough members, and only those', async () => {
    history.resetPopularCache();
    const { items } = await history.popular();
    const mine = items.filter((t) => t.startsWith(MARK)).sort();
    expect(mine).toEqual([name(0), name(1)].sort());
  });

  it('counts the members of the searched rooms only, not of every room with a name', async () => {
    const asked: { text: string; values: unknown[] }[] = [];
    const real = prisma.$queryRaw.bind(prisma) as (
      ...args: unknown[]
    ) => Promise<unknown>;
    const spy = jest.spyOn(prisma, '$queryRaw').mockImplementation(((query: {
      text: string;
      values: unknown[];
    }) => {
      asked.push({ text: query.text, values: query.values });
      return real(query);
    }) as never);
    try {
      history.resetPopularCache();
      await history.popular();
    } finally {
      spy.mockRestore();
    }
    const popular = asked.find((q) => q.text.includes('"CommunityMembership"'));
    expect(popular).toBeDefined();

    const plan = await prisma.$queryRawUnsafe<
      { 'QUERY PLAN': { Plan: PlanNode }[] }[]
    >(`EXPLAIN (ANALYZE, FORMAT JSON) ${popular!.text}`, ...popular!.values);
    const root = plan[0]['QUERY PLAN'][0].Plan;
    const loops = loopsOf(root, 'CommunityMembership');
    expect(loops.length).toBeGreaterThan(0);
    // Once per room whose name was searched, never once per room: the 40 made
    // here are showable too, and the rooms other suites left come on top.
    const [{ matched, rooms }] = await prisma.$queryRaw<
      { matched: number; rooms: number }[]
    >(Prisma.sql`
      SELECT COUNT(*) FILTER (WHERE ${foldSql(Prisma.raw('m.name'))} IN (
               SELECT ${foldSql(Prisma.raw('h."queryKey"'))} FROM "SearchHistory" h))::int AS matched,
             COUNT(*)::int AS rooms
      FROM "Community" m
      WHERE ${showableNameSql(Prisma.raw('m.name'))}`);
    expect(rooms).toBeGreaterThanOrEqual(ROOMS);
    expect(matched).toBeGreaterThanOrEqual(SEARCHED);
    expect(matched).toBeLessThan(rooms);
    expect(Math.max(...loops)).toBeLessThanOrEqual(matched);
  });
});
