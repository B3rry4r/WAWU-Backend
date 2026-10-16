// Run against the contract test database (set DATABASE_URL before invoking
// jest) - same convention as every other contract spec in this repo.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ConfigModule } from '@nestjs/config';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { CommunityModule } from '../community.module';

/**
 * FIX-28: GET /communities pages by offset, and a community's name is not
 * unique. Ordered by name alone, two communities with the same name come back
 * in whatever order the database happens to produce for that one query, and
 * the order can differ between the query for page 1 and the query for page 2.
 * One of the two can then be on both pages, and the other on neither.
 *
 * The list orders by name and then by id, so equal names have one order.
 *
 * The fixtures: a group of communities with one shared name, made with ids
 * that FALL in the order they are inserted (so neither insertion order nor
 * id order is the answer by luck), plus a second pair with another shared
 * name. Walking the list at small page sizes puts a page edge inside each
 * group (at a page size of 1 every edge is inside one). The list must be the
 * same walk at every page size, each community once, and each group in
 * ascending id order.
 */
const MOCK_WAWU_ID_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_WAWU_ID_BASE = `http://localhost:${MOCK_WAWU_ID_PORT}`;

const HOST = '00000000-0000-4000-8000-000000000003'; // seeded creator
const uid = (n: number) =>
  `28000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const BIG_NAME = 'FIX28 Tie Break Circle';
const PAIR_NAME = 'FIX28 Tie Break Pair';
/** Ids fall as they are inserted: the first made has the largest id. */
const BIG_IDS = [0x50, 0x40, 0x30, 0x20, 0x10].map(uid);
const PAIR_IDS = [0x92, 0x91].map(uid);
const FIXTURE_IDS = [...BIG_IDS, ...PAIR_IDS];

async function waitForHealth(url: string, timeoutMs = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function login(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_WAWU_ID_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) {
    throw new Error(
      `mock-wawu-id login failed for ${identifier}: ${res.status}`,
    );
  }
  return ((await res.json()) as { accessToken: string }).accessToken;
}

type Item = { id: string; name: string };
type ListBody = {
  data: Item[];
  pagination: { currentPage: number; nextPage: number | null; total: number };
};

describe('GET /communities orders equal names by id (FIX-28)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mockWawuId: ChildProcess | undefined;
  let token: string;

  const pageOf = async (page: number, perPage: number): Promise<ListBody> =>
    (
      await request(app.getHttpServer() as Parameters<typeof request>[0])
        .get('/communities')
        .query({ page, perPage })
        .set('Authorization', `Bearer ${token}`)
        .expect(200)
    ).body as ListBody;

  /** Every page in turn, until the response says there is no next page. */
  const walk = async (perPage: number): Promise<Item[]> => {
    const seen: Item[] = [];
    let page = 1;
    for (;;) {
      const body = await pageOf(page, perPage);
      expect(body.data.length).toBeLessThanOrEqual(perPage);
      seen.push(...body.data);
      if (body.pagination.nextPage === null) return seen;
      page = body.pagination.nextPage;
    }
  };

  const cleanUp = () =>
    prisma.community.deleteMany({ where: { id: { in: FIXTURE_IDS } } });

  beforeAll(async () => {
    const alreadyUp = await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`, 1000);
    if (!alreadyUp) {
      mockWawuId = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '../../../mock-wawu-id'),
        env: { ...process.env, MOCK_WAWU_ID_PORT },
        stdio: 'ignore',
      });
      if (!(await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`))) {
        throw new Error('mock-wawu-id did not become healthy in time');
      }
    }
    token = await login('user@test.wawu.dev');

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        CommunityModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();
    prisma = moduleRef.get(PrismaService);

    await cleanUp();
    // The groups are made interleaved, so the rows of one name are not next
    // to each other on disk either.
    const order: Array<[string, string]> = [
      [BIG_IDS[0], BIG_NAME],
      [PAIR_IDS[0], PAIR_NAME],
      [BIG_IDS[1], BIG_NAME],
      [BIG_IDS[2], BIG_NAME],
      [PAIR_IDS[1], PAIR_NAME],
      [BIG_IDS[3], BIG_NAME],
      [BIG_IDS[4], BIG_NAME],
    ];
    for (const [id, name] of order) {
      await prisma.community.create({
        data: {
          id,
          name,
          description: 'Fixture for community-list-order.contract.spec.ts.',
          hostWawuId: HOST,
          kind: 'open',
        },
      });
    }
  }, 60_000);

  afterAll(async () => {
    await cleanUp();
    await app.close();
    if (mockWawuId) mockWawuId.kill();
  });

  it('communities with one name come back in ascending id order', async () => {
    const all = await walk(100);
    const ids = all.map((c) => c.id);
    expect(ids.filter((id) => BIG_IDS.includes(id))).toEqual(
      [...BIG_IDS].sort(),
    );
    expect(ids.filter((id) => PAIR_IDS.includes(id))).toEqual(
      [...PAIR_IDS].sort(),
    );
    // each group sits together
    for (const group of [BIG_IDS, PAIR_IDS]) {
      const at = group.map((id) => ids.indexOf(id)).sort((a, b) => a - b);
      expect(at[at.length - 1] - at[0]).toBe(group.length - 1);
    }
  });

  it('a walk at every page size sees each community once, in the order of one big page', async () => {
    const big = (await walk(100)).map((c) => c.id);
    expect(new Set(big).size).toBe(big.length);
    expect(big).toEqual(expect.arrayContaining(FIXTURE_IDS));
    for (const perPage of [1, 2, 3, 4, 5, 6, 7, 9]) {
      const seen = (await walk(perPage)).map((c) => c.id);
      expect(new Set(seen).size).toBe(seen.length); // none twice
      expect(seen).toEqual(big); // none missing, same order
    }
  });

  it('a page edge inside the group puts each member on one page only', async () => {
    const big = (await walk(100)).map((c) => c.id);
    const first = big.indexOf([...BIG_IDS].sort()[0]);
    // Pages whose edge falls after the 2nd member of the group.
    const perPage = first + 2;
    const a = await pageOf(1, perPage);
    const b = await pageOf(2, perPage);
    const ids = [...a.data, ...b.data].map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(big.slice(0, ids.length));
    expect(a.data.map((c) => c.id)).toContain([...BIG_IDS].sort()[1]);
    expect(b.data.map((c) => c.id)).toContain([...BIG_IDS].sort()[2]);
  });
});
