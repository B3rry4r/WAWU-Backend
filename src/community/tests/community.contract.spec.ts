// Run against wawu_hub_test (set DATABASE_URL before invoking jest, per the
// build brief) — same convention as every other Phase 5 contract spec
// (see src/course-enrollment/tests/course-enrollment.contract.spec.ts).
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

// Seeded WAWU IDs — mirror mock-wawu-id/server.js and prisma/seed.ts exactly
// (see WAWU-Hub-API build task brief / src/course-enrollment's contract spec).
const USER_PLAIN = '00000000-0000-4000-8000-000000000001'; // already a `joined` member of COMMUNITY_FOUNDERS via seed
const USER_CREATOR_BASIC = '00000000-0000-4000-8000-000000000002'; // no seeded membership of COMMUNITY_FOUNDERS
const USER_CREATOR_PRO = '00000000-0000-4000-8000-000000000003'; // hosts COMMUNITY_FOUNDERS

const COMMUNITY_FOUNDERS = '20000000-0000-4000-8000-000000000001'; // seeded, kind=open
const MEMBERSHIP_PLAIN_IN_FOUNDERS = '21000000-0000-4000-8000-000000000001'; // seeded, status=joined
const NON_EXISTENT_COMMUNITY = '20000000-0000-4000-8000-00000000dead';

// This spec's own fixtures — fresh UUIDs, never touched by seed.ts or any
// other resource's spec, deleted in afterAll (task brief § test hygiene).
const TEST_COMMUNITY_OPEN = 'c1000000-0000-4000-8000-000000000001';
const TEST_COMMUNITY_PRIVATE = 'c1000000-0000-4000-8000-000000000002';
const TEST_COMMUNITY_COUNTS = 'c1000000-0000-4000-8000-000000000003';

const MOCK_WAWU_ID_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_WAWU_ID_BASE = `http://localhost:${MOCK_WAWU_ID_PORT}`;

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
  const body = (await res.json()) as { accessToken: string };
  return body.accessToken;
}

describe('Community (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mockWawuId: ChildProcess | undefined;
  let ownedMockWawuId = false;

  let plainUserToken: string;
  let basicCreatorToken: string;
  let proCreatorToken: string;

  beforeAll(async () => {
    // Reuse an already-running mock WAWU ID if present, otherwise spawn one
    // for this test run (conventions.md § Local test environment).
    const alreadyUp = await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`, 1000);
    if (!alreadyUp) {
      mockWawuId = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '../../../mock-wawu-id'),
        env: { ...process.env, MOCK_WAWU_ID_PORT },
        stdio: 'ignore',
      });
      ownedMockWawuId = true;
      const up = await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`);
      if (!up) {
        throw new Error('mock-wawu-id did not become healthy in time');
      }
    }

    plainUserToken = await login('user@test.wawu.dev');
    basicCreatorToken = await login('creator-basic@test.wawu.dev');
    proCreatorToken = await login('creator-pro@test.wawu.dev');

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

    // Fixtures this spec owns outright (fresh UUIDs, cleaned up in afterAll).
    await prisma.community.create({
      data: {
        id: TEST_COMMUNITY_OPEN,
        name: 'TEST: Open Community',
        description:
          'Fixture for community.contract.spec.ts — join flow, kind=open.',
        hostWawuId: USER_CREATOR_PRO,
        kind: 'open',
      },
    });
    await prisma.community.create({
      data: {
        id: TEST_COMMUNITY_PRIVATE,
        name: 'TEST: Private Community',
        description:
          'Fixture for community.contract.spec.ts — join flow, kind=private.',
        hostWawuId: USER_CREATOR_PRO,
        kind: 'private',
      },
    });

    // Dedicated community for derived-field math, isolated from any other
    // spec/seed activity: 2 `joined` memberships + 1 `pending` (memberCount
    // must be 2, not 3), 2 messages sent "today" + 1 backdated to well
    // before start-of-day UTC (messagesToday must be 2, not 3).
    await prisma.community.create({
      data: {
        id: TEST_COMMUNITY_COUNTS,
        name: 'TEST: Derived Counts Community',
        description:
          'Fixture for community.contract.spec.ts — memberCount/messagesToday math.',
        hostWawuId: USER_CREATOR_PRO,
        kind: 'open',
      },
    });
    await prisma.communityMembership.createMany({
      data: [
        {
          userWawuId: USER_PLAIN,
          communityId: TEST_COMMUNITY_COUNTS,
          status: 'joined',
          joinedAt: new Date(),
        },
        {
          userWawuId: USER_CREATOR_BASIC,
          communityId: TEST_COMMUNITY_COUNTS,
          status: 'joined',
          joinedAt: new Date(),
        },
        {
          userWawuId: USER_CREATOR_PRO,
          communityId: TEST_COMMUNITY_COUNTS,
          status: 'pending',
          joinedAt: null,
        },
      ],
    });
    const yesterdayUtc = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await prisma.communityMessage.createMany({
      data: [
        {
          communityId: TEST_COMMUNITY_COUNTS,
          senderWawuId: USER_PLAIN,
          text: 'today 1',
          sentAt: new Date(),
        },
        {
          communityId: TEST_COMMUNITY_COUNTS,
          senderWawuId: USER_PLAIN,
          text: 'today 2',
          sentAt: new Date(),
        },
        {
          communityId: TEST_COMMUNITY_COUNTS,
          senderWawuId: USER_PLAIN,
          text: 'yesterday, should not count',
          sentAt: yesterdayUtc,
        },
      ],
    });
  }, 30000);

  afterAll(async () => {
    // Undo everything this spec created so the seed/shared state is clean
    // for other resources' specs run against the same wawu_hub_test DB.
    // Deleting the Community rows cascades onto their CommunityMembership /
    // CommunityMessage children (schema: onDelete: Cascade on both), so no
    // separate child-row cleanup is needed.
    await prisma.community.deleteMany({
      where: {
        id: {
          in: [
            TEST_COMMUNITY_OPEN,
            TEST_COMMUNITY_PRIVATE,
            TEST_COMMUNITY_COUNTS,
          ],
        },
      },
    });
    // Any membership this spec's join tests created against the fixtures
    // above is already gone via cascade; nothing else was mutated.
    await app?.close();
    if (ownedMockWawuId && mockWawuId) {
      mockWawuId.kill();
    }
  });

  describe('GET /communities', () => {
    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer()).get('/communities').expect(401);
    });

    it('200s with a paginated list including derived fields, and includes the seeded community', async () => {
      const res = await request(app.getHttpServer())
        .get('/communities')
        .query({ page: 1, perPage: 50 })
        .set('Authorization', `Bearer ${plainUserToken}`)
        .expect(200);

      expect(res.body.pagination).toEqual({
        currentPage: 1,
        nextPage: null,
        perPage: 50,
        total: expect.any(Number),
      });
      expect(Array.isArray(res.body.data)).toBe(true);

      const founders = res.body.data.find(
        (c: { id: string }) => c.id === COMMUNITY_FOUNDERS,
      );
      expect(founders).toMatchObject({
        id: COMMUNITY_FOUNDERS,
        name: 'SEEDED: WAWU Founders Circle',
        kind: 'open',
        memberCount: expect.any(Number),
        messagesToday: expect.any(Number),
      });

      const countsFixture = res.body.data.find(
        (c: { id: string }) => c.id === TEST_COMMUNITY_COUNTS,
      );
      expect(countsFixture).toMatchObject({ memberCount: 2, messagesToday: 2 });
    });
  });

  describe('GET /communities/:id', () => {
    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer())
        .get(`/communities/${COMMUNITY_FOUNDERS}`)
        .expect(401);
    });

    it('404s for a community id that does not exist', async () => {
      await request(app.getHttpServer())
        .get(`/communities/${NON_EXISTENT_COMMUNITY}`)
        .set('Authorization', `Bearer ${plainUserToken}`)
        .expect(404);
    });

    it('400s a malformed community id (not a UUID)', async () => {
      await request(app.getHttpServer())
        .get('/communities/not-a-uuid')
        .set('Authorization', `Bearer ${plainUserToken}`)
        .expect(400);
    });

    it('200s with the exact derived memberCount/messagesToday for the counts fixture', async () => {
      const res = await request(app.getHttpServer())
        .get(`/communities/${TEST_COMMUNITY_COUNTS}`)
        .set('Authorization', `Bearer ${plainUserToken}`)
        .expect(200);

      expect(res.body.data).toEqual({
        id: TEST_COMMUNITY_COUNTS,
        name: 'TEST: Derived Counts Community',
        description:
          'Fixture for community.contract.spec.ts — memberCount/messagesToday math.',
        hostWawuId: USER_CREATOR_PRO,
        kind: 'open',
        memberCount: 2,
        messagesToday: 2,
      });
    });
  });

  describe('POST /communities/:id/join', () => {
    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer())
        .post(`/communities/${TEST_COMMUNITY_OPEN}/join`)
        .expect(401);
    });

    it('404s for a community id that does not exist', async () => {
      await request(app.getHttpServer())
        .post(`/communities/${NON_EXISTENT_COMMUNITY}/join`)
        .set('Authorization', `Bearer ${basicCreatorToken}`)
        .expect(404);
    });

    it('400s a malformed community id (not a UUID)', async () => {
      await request(app.getHttpServer())
        .post('/communities/not-a-uuid/join')
        .set('Authorization', `Bearer ${basicCreatorToken}`)
        .expect(400);
    });

    it('joins an open community instantly: status=joined, joinedAt set (200)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/communities/${TEST_COMMUNITY_OPEN}/join`)
        .set('Authorization', `Bearer ${basicCreatorToken}`)
        .expect(200);

      expect(res.body.data).toMatchObject({
        userWawuId: USER_CREATOR_BASIC,
        communityId: TEST_COMMUNITY_OPEN,
        status: 'joined',
      });
      expect(res.body.data.joinedAt).not.toBeNull();
    });

    it('is idempotent re-joining an open community: same row, no error, no double-join (200)', async () => {
      const first = await request(app.getHttpServer())
        .post(`/communities/${TEST_COMMUNITY_OPEN}/join`)
        .set('Authorization', `Bearer ${basicCreatorToken}`)
        .expect(200);

      const second = await request(app.getHttpServer())
        .post(`/communities/${TEST_COMMUNITY_OPEN}/join`)
        .set('Authorization', `Bearer ${basicCreatorToken}`)
        .expect(200);

      expect(second.body.data).toEqual(first.body.data);

      const rows = await prisma.communityMembership.findMany({
        where: {
          userWawuId: USER_CREATOR_BASIC,
          communityId: TEST_COMMUNITY_OPEN,
        },
      });
      expect(rows).toHaveLength(1);
    });

    it('is idempotent re-joining the seeded, already-joined community without erroring or mutating the seeded row', async () => {
      const res = await request(app.getHttpServer())
        .post(`/communities/${COMMUNITY_FOUNDERS}/join`)
        .set('Authorization', `Bearer ${plainUserToken}`)
        .expect(200);

      expect(res.body.data).toMatchObject({
        id: MEMBERSHIP_PLAIN_IN_FOUNDERS,
        userWawuId: USER_PLAIN,
        communityId: COMMUNITY_FOUNDERS,
        status: 'joined',
      });
    });

    it('creates a pending membership for a private community: status=pending, joinedAt=null (200)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/communities/${TEST_COMMUNITY_PRIVATE}/join`)
        .set('Authorization', `Bearer ${proCreatorToken}`)
        .expect(200);

      expect(res.body.data).toMatchObject({
        userWawuId: USER_CREATOR_PRO,
        communityId: TEST_COMMUNITY_PRIVATE,
        status: 'pending',
        joinedAt: null,
      });
    });

    it('is idempotent re-joining a pending private-community membership: still pending, not auto-approved (200)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/communities/${TEST_COMMUNITY_PRIVATE}/join`)
        .set('Authorization', `Bearer ${proCreatorToken}`)
        .expect(200);

      expect(res.body.data).toMatchObject({
        userWawuId: USER_CREATOR_PRO,
        communityId: TEST_COMMUNITY_PRIVATE,
        status: 'pending',
        joinedAt: null,
      });
    });
  });
});
