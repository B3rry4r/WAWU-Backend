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

// Names the POST /communities tests ask the API to create. Swept in afterAll
// so a failed assertion can never leave a row behind for the next run.
const CREATED_COMMUNITY_NAMES = [
  'TEST: Basic Creator Open Community',
  'TEST: Basic Creator Private Attempt',
  'TEST: Pro Creator Private Community',
  'TEST: Pro Second Community A',
  'TEST: Pro Second Community B',
];

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

/**
 * The POST/PATCH gate matrix needs identities the seed does not provide (a
 * creator with no CreatorState row) and, more importantly, identities no
 * OTHER spec can move under it. Several specs mutate the three seeded
 * accounts against this shared wawu_hub_test database — the seeded creator's
 * slots are edited elsewhere — so pinning a gate result to a seeded row makes
 * it depend on test order.
 *
 * Each gate test therefore runs against a throwaway WAWU ID registered by
 * this spec, with a UserProfile + CreatorState this spec owns outright and
 * deletes in afterAll. A per-run-unique email keeps the mock's
 * 409-on-taken-email from firing when the mock server is reused across runs.
 */
let throwawayNonce = 0;
async function registerThrowawayIdentity(
  label: string,
): Promise<{ sub: string; accessToken: string }> {
  const nonce = `${Date.now().toString().slice(-8)}${(throwawayNonce += 1)}`;
  const res = await fetch(`${MOCK_WAWU_ID_BASE}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fullName: `Community Spec ${label}`,
      email: `community-spec-${label}-${nonce}@test.wawu.dev`,
      phone: `+2349${nonce}`,
      country: 'NG',
      password: 'not-a-real-password',
    }),
  });
  if (!res.ok) {
    throw new Error(`mock-wawu-id register failed for ${label}: ${res.status}`);
  }
  const body = (await res.json()) as {
    accessToken: string;
    user: { id: string };
  };
  return { sub: body.user.id, accessToken: body.accessToken };
}

describe('Community (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mockWawuId: ChildProcess | undefined;
  let ownedMockWawuId = false;

  let plainUserToken: string;
  let basicCreatorToken: string;
  let proCreatorToken: string;
  // Spec-owned identities (see registerThrowawayIdentity) — the gate matrix
  // runs against these, never against the mutable seeded accounts.
  let ownPlainUserToken: string;
  let ownUnpaidCreatorToken: string;
  let ownUnpaidCreatorSub: string;
  let ownBasicCreatorToken: string;
  let ownBasicCreatorSub: string;
  let ownProCreatorToken: string;
  let ownProCreatorSub: string;
  /** Every wawuUserId this spec registered — profiles/states torn down in afterAll. */
  const ownedSubs: string[] = [];

  /** Communities created by the POST /communities tests — cleaned up in afterAll. */
  const createdCommunityIds: string[] = [];

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

    const ownPlain = await registerThrowawayIdentity('plain');
    const ownUnpaid = await registerThrowawayIdentity('unpaid');
    const ownBasic = await registerThrowawayIdentity('basic');
    const ownPro = await registerThrowawayIdentity('pro');
    ownPlainUserToken = ownPlain.accessToken;
    ownUnpaidCreatorToken = ownUnpaid.accessToken;
    ownUnpaidCreatorSub = ownUnpaid.sub;
    ownBasicCreatorToken = ownBasic.accessToken;
    ownBasicCreatorSub = ownBasic.sub;
    ownProCreatorToken = ownPro.accessToken;
    ownProCreatorSub = ownPro.sub;
    ownedSubs.push(ownPlain.sub, ownUnpaid.sub, ownBasic.sub, ownPro.sub);

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

    // The gate matrix, as four rows this spec fully controls. The creators
    // are deliberately kycStatus='pending': KYC gates EARNING, never hosting
    // (CLAUDE.md — the creator gates are independent), and that independence
    // is exactly what these tests exist to pin. `ownUnpaid` is now a creator
    // with NO CreatorState row at all, which is what a brand-new creator
    // looks like: hosting is no longer bought, so it must be allowed.
    const ownProfiles: Array<{
      sub: string;
      accountType: 'user' | 'creator';
      state?: boolean;
    }> = [
      { sub: ownPlain.sub, accountType: 'user' },
      { sub: ownUnpaid.sub, accountType: 'creator' },
      { sub: ownBasic.sub, accountType: 'creator', state: true },
      { sub: ownPro.sub, accountType: 'creator', state: true },
    ];
    for (const { sub, accountType, state } of ownProfiles) {
      await prisma.userProfile.upsert({
        where: { wawuUserId: sub },
        update: { accountType },
        create: {
          wawuUserId: sub,
          accountType,
          bio: 'Fixture for community.contract.spec.ts.',
          interests: [],
        },
      });
      if (state) {
        await prisma.creatorState.upsert({
          where: { wawuUserId: sub },
          update: { kycStatus: 'pending' },
          create: {
            wawuUserId: sub,
            kycStatus: 'pending',
            slotsUsed: 0,
            dmPrice: null,
            dmEnabled: false,
          },
        });
      }
    }

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
    // Communities the POST /communities tests created (ids only known at
    // runtime), then the throwaway identities' own rows. The name sweep is
    // belt-and-braces: if an assertion fails BEFORE the new id is recorded,
    // an id-only cleanup would leave the row behind and poison the next run
    // (which is exactly what happened once).
    if (createdCommunityIds.length > 0) {
      await prisma.community.deleteMany({
        where: { id: { in: createdCommunityIds } },
      });
    }
    await prisma.community.deleteMany({
      where: { name: { in: CREATED_COMMUNITY_NAMES } },
    });
    if (ownedSubs.length > 0) {
      await prisma.community.deleteMany({
        where: { hostWawuId: { in: ownedSubs } },
      });
      await prisma.creatorState.deleteMany({
        where: { wawuUserId: { in: ownedSubs } },
      });
      await prisma.userProfile.deleteMany({
        where: { wawuUserId: { in: ownedSubs } },
      });
    }
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
        imageUrl: null,
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

  /**
   * The hosting gap: community hosting is a SOLD subscription feature
   * (docs/01_SPEC.md — Basic "cannot open/host private communities", Pro
   * "Can open/host private communities") and yet nothing in this backend
   * could write a Community row. These tests pin the write path AND, just as
   * importantly, which gates apply to it.
   */
  describe('POST /communities', () => {
    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer())
        .post('/communities')
        .send({ name: 'No auth', description: 'No auth', kind: 'open' })
        .expect(401);
    });

    it('403s a plain (non-creator) account', async () => {
      const res = await request(app.getHttpServer())
        .post('/communities')
        .set('Authorization', `Bearer ${ownPlainUserToken}`)
        .send({
          name: 'Plain user community',
          description: 'A plain user should not be able to host.',
          kind: 'open',
        })
        .expect(403);

      expect(res.body.message).toBe(
        'This endpoint is only available to creator accounts.',
      );
    });

    it('lets a creator with no CreatorState row host, because hosting is not bought', async () => {
      // This used to 403 with "A paid subscription is required to host a
      // community". Subscriptions are gone, and a brand-new creator has no
      // CreatorState row at all, so refusing them would be the payment gate
      // under another name. The account-type gate above is what still holds.
      const res = await request(app.getHttpServer())
        .post('/communities')
        .set('Authorization', `Bearer ${ownUnpaidCreatorToken}`)
        .send({
          name: 'TEST: Brand New Creator Community',
          description: 'Hosting needs a creator account and nothing else.',
          kind: 'open',
        });

      expect([200, 201]).toContain(res.status);
      createdCommunityIds.push(res.body.data.id);

      const rows = await prisma.community.count({
        where: { hostWawuId: ownUnpaidCreatorSub },
      });
      expect(rows).toBe(1);
    });

    it('creates an open community for a creator whose KYC is still PENDING (KYC gates earning, not hosting)', async () => {
      // The precondition is asserted, not assumed: the whole point of this
      // test is that "publishing + KYC pending" is a normal, allowed state,
      // and this exact independence has been got wrong in this codebase
      // before. KYC is untouched by the subscription teardown.
      const state = await prisma.creatorState.findUnique({
        where: { wawuUserId: ownBasicCreatorSub },
      });
      expect(state).toMatchObject({ kycStatus: 'pending' });

      const res = await request(app.getHttpServer())
        .post('/communities')
        .set('Authorization', `Bearer ${ownBasicCreatorToken}`)
        .send({
          name: 'TEST: Basic Creator Open Community',
          description: 'Opened by a creator with KYC pending.',
          kind: 'open',
        });

      expect([200, 201]).toContain(res.status);
      createdCommunityIds.push(res.body.data.id);

      expect(res.body.data).toEqual({
        id: expect.any(String),
        name: 'TEST: Basic Creator Open Community',
        description: 'Opened by a creator with KYC pending.',
        hostWawuId: ownBasicCreatorSub,
        kind: 'open',
        // No image was sent, so the room has none and the client falls back
        // to its placeholder tile — see community-image.contract.spec.ts.
        imageUrl: null,
        // Host-implies-member is this codebase's existing convention
        // (CommunityMessageService.assertMember short-circuits on the host),
        // so no CommunityMembership row is written for the host and the
        // derived memberCount starts at 0.
        memberCount: 0,
        messagesToday: 0,
      });

      const stored = await prisma.community.findUnique({
        where: { id: res.body.data.id },
      });
      expect(stored).toMatchObject({
        hostWawuId: ownBasicCreatorSub,
        kind: 'open',
      });

      const hostMembership = await prisma.communityMembership.findUnique({
        where: {
          userWawuId_communityId: {
            userWawuId: ownBasicCreatorSub,
            communityId: res.body.data.id,
          },
        },
      });
      expect(hostMembership).toBeNull();
    });

    it('lets any creator host a PRIVATE community, because there is no tier left to sell it', async () => {
      // This used to 403 with "Private communities are a Pro-tier feature".
      // The tier that sold it is gone, so the check went with it rather than
      // being reinterpreted against something else.
      const res = await request(app.getHttpServer())
        .post('/communities')
        .set('Authorization', `Bearer ${ownBasicCreatorToken}`)
        .send({
          name: 'TEST: Basic Creator Private Attempt',
          description: 'Private hosting is open to every creator account.',
          kind: 'private',
        });

      expect([200, 201]).toContain(res.status);
      createdCommunityIds.push(res.body.data.id);

      // Created as asked for, never silently downgraded to an open community.
      const stored = await prisma.community.findFirst({
        where: { name: 'TEST: Basic Creator Private Attempt' },
      });
      expect(stored).toMatchObject({ kind: 'private' });
    });

    it('creates a PRIVATE community for a Pro creator', async () => {
      const res = await request(app.getHttpServer())
        .post('/communities')
        .set('Authorization', `Bearer ${ownProCreatorToken}`)
        .send({
          name: 'TEST: Pro Creator Private Community',
          description: 'Private hosting is open to every creator account.',
          kind: 'private',
        });

      expect([200, 201]).toContain(res.status);
      createdCommunityIds.push(res.body.data.id);

      expect(res.body.data).toMatchObject({
        name: 'TEST: Pro Creator Private Community',
        hostWawuId: ownProCreatorSub,
        kind: 'private',
      });
    });

    it('lets a Pro creator host more than one community (no invented cap)', async () => {
      const first = await request(app.getHttpServer())
        .post('/communities')
        .set('Authorization', `Bearer ${ownProCreatorToken}`)
        .send({
          name: 'TEST: Pro Second Community A',
          description: 'The spec states no per-creator community cap.',
          kind: 'open',
        });
      const second = await request(app.getHttpServer())
        .post('/communities')
        .set('Authorization', `Bearer ${ownProCreatorToken}`)
        .send({
          name: 'TEST: Pro Second Community B',
          description: 'The spec states no per-creator community cap.',
          kind: 'open',
        });

      expect([200, 201]).toContain(first.status);
      expect([200, 201]).toContain(second.status);
      createdCommunityIds.push(first.body.data.id, second.body.data.id);
      expect(first.body.data.id).not.toBe(second.body.data.id);
    });

    it('400s an invalid kind, a missing name, an over-long name and a whitespace-only name', async () => {
      await request(app.getHttpServer())
        .post('/communities')
        .set('Authorization', `Bearer ${ownBasicCreatorToken}`)
        .send({ name: 'Valid name', description: 'Valid', kind: 'secret' })
        .expect(400);

      await request(app.getHttpServer())
        .post('/communities')
        .set('Authorization', `Bearer ${ownBasicCreatorToken}`)
        .send({ description: 'No name given', kind: 'open' })
        .expect(400);

      await request(app.getHttpServer())
        .post('/communities')
        .set('Authorization', `Bearer ${ownBasicCreatorToken}`)
        .send({ name: 'x'.repeat(81), description: 'Too long', kind: 'open' })
        .expect(400);

      await request(app.getHttpServer())
        .post('/communities')
        .set('Authorization', `Bearer ${ownBasicCreatorToken}`)
        .send({ name: '     ', description: 'Blank name', kind: 'open' })
        .expect(400);
    });

    it('400s an unknown field (whitelist is enforced — hostWawuId is never client-supplied)', async () => {
      await request(app.getHttpServer())
        .post('/communities')
        .set('Authorization', `Bearer ${ownBasicCreatorToken}`)
        .send({
          name: 'Spoofed host',
          description: 'hostWawuId must come from the token, not the body.',
          kind: 'open',
          hostWawuId: USER_CREATOR_PRO,
        })
        .expect(400);
    });
  });

  describe('PATCH /communities/:id', () => {
    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer())
        .patch(`/communities/${TEST_COMMUNITY_OPEN}`)
        .send({ name: 'Renamed' })
        .expect(401);
    });

    it('403s a plain (non-creator) account', async () => {
      await request(app.getHttpServer())
        .patch(`/communities/${TEST_COMMUNITY_OPEN}`)
        .set('Authorization', `Bearer ${ownPlainUserToken}`)
        .send({ name: 'Renamed by a plain user' })
        .expect(403);
    });

    it('403s a creator who is not the host', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/communities/${TEST_COMMUNITY_OPEN}`)
        .set('Authorization', `Bearer ${ownBasicCreatorToken}`)
        .send({ name: 'Renamed by another creator' })
        .expect(403);

      expect(res.body.message).toBe(
        'Only the community host can edit this community.',
      );
    });

    it('404s a community that does not exist', async () => {
      await request(app.getHttpServer())
        .patch(`/communities/${NON_EXISTENT_COMMUNITY}`)
        .set('Authorization', `Bearer ${proCreatorToken}`)
        .send({ name: 'Renamed' })
        .expect(404);
    });

    it('400s an empty body', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/communities/${TEST_COMMUNITY_OPEN}`)
        .set('Authorization', `Bearer ${proCreatorToken}`)
        .send({})
        .expect(400);

      expect(res.body.message).toBe(
        'Nothing to update — send a name, a description and/or an image.',
      );
    });

    it('400s an attempt to change kind (immutable)', async () => {
      await request(app.getHttpServer())
        .patch(`/communities/${TEST_COMMUNITY_OPEN}`)
        .set('Authorization', `Bearer ${proCreatorToken}`)
        .send({ kind: 'private' })
        .expect(400);
    });

    it('updates name and description for the host, leaving kind and host untouched (200)', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/communities/${TEST_COMMUNITY_OPEN}`)
        .set('Authorization', `Bearer ${proCreatorToken}`)
        .send({
          name: 'TEST: Open Community (renamed)',
          description: 'Edited by the host via PATCH.',
        })
        .expect(200);

      expect(res.body.data).toMatchObject({
        id: TEST_COMMUNITY_OPEN,
        name: 'TEST: Open Community (renamed)',
        description: 'Edited by the host via PATCH.',
        hostWawuId: USER_CREATOR_PRO,
        kind: 'open',
      });

      const stored = await prisma.community.findUnique({
        where: { id: TEST_COMMUNITY_OPEN },
      });
      expect(stored).toMatchObject({
        name: 'TEST: Open Community (renamed)',
        kind: 'open',
      });
    });

    it('accepts a partial update: description only, name preserved (200)', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/communities/${TEST_COMMUNITY_OPEN}`)
        .set('Authorization', `Bearer ${proCreatorToken}`)
        .send({ description: 'Description-only edit.' })
        .expect(200);

      expect(res.body.data).toMatchObject({
        name: 'TEST: Open Community (renamed)',
        description: 'Description-only edit.',
      });
    });
  });
});
