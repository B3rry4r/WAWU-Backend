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
import { UserProfileModule } from '../user-profile.module';

// Seeded WAWU IDs — mirror mock-wawu-id/server.js and prisma/seed.ts exactly
// (see WAWU-Hub-API build task brief).
const USER_PLAIN = '00000000-0000-4000-8000-000000000001'; // plain user
const USER_CREATOR_BASIC = '00000000-0000-4000-8000-000000000002'; // Basic creator, kyc pending

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
 * ME-02: the visitor's view of a profile (M5, M6, M33) in one answer.
 * Written as what a user can do.
 */
describe('Visitor profile (ME-02, contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mockWawuId: ChildProcess | undefined;
  let ownedMockWawuId = false;
  let userToken: string;
  let creatorBasicToken: string;
  const created: { listing?: string; follow?: string; block?: string } = {};

  beforeAll(async () => {
    const alreadyUp = await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`, 1000);
    if (!alreadyUp) {
      mockWawuId = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '../../../mock-wawu-id'),
        env: { ...process.env, MOCK_WAWU_ID_PORT },
        stdio: 'ignore',
      });
      ownedMockWawuId = true;
      if (!(await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`))) {
        throw new Error('mock-wawu-id did not become healthy in time');
      }
    }
    userToken = await login('user@test.wawu.dev');
    creatorBasicToken = await login('creator-basic@test.wawu.dev');

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        UserProfileModule,
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
  }, 30000);

  const clean = async () => {
    await prisma.followRelationship.deleteMany({
      where: {
        followerWawuId: USER_PLAIN,
        followingWawuId: USER_CREATOR_BASIC,
      },
    });
    await prisma.blockedAccount.deleteMany({
      where: { userWawuId: USER_PLAIN, blockedWawuId: USER_CREATOR_BASIC },
    });
    await prisma.blockedAccount.deleteMany({
      where: { userWawuId: USER_CREATOR_BASIC, blockedWawuId: USER_PLAIN },
    });
    await prisma.professionalProfile.deleteMany({
      where: {
        wawuUserId: USER_CREATOR_BASIC,
        headline: { startsWith: 'ME-02 ' },
      },
    });
  };
  beforeEach(clean);
  afterAll(async () => {
    await clean();
    await app?.close();
    if (ownedMockWawuId && mockWawuId) mockWawuId.kill();
  });

  const visit = (token: string, who: string) =>
    request(app.getHttpServer())
      .get(`/users/${who}/visitor-profile`)
      .set('Authorization', `Bearer ${token}`);
  const listing = (
    headline: string,
    category: string,
    listed: boolean,
    status: 'approved' | 'pending',
  ) =>
    prisma.professionalProfile.create({
      data: {
        wawuUserId: USER_CREATOR_BASIC,
        category,
        headline,
        about: 'ME-02 test listing',
        credentialKind: 'portfolio',
        status,
        listed,
        reviewedAt: status === 'approved' ? new Date() : null,
      },
    });

  it('a user can open a creator and get the header, the counts, the details and the name in one answer, by id and by handle', async () => {
    const byId = await visit(userToken, USER_CREATOR_BASIC).expect(200);
    const view = byId.body.data;
    expect(view.own).toBe(false);
    expect(view.following).toBe(false);
    expect(view.profile.wawuUserId).toBe(USER_CREATOR_BASIC);
    expect(typeof view.profile.followerCount).toBe('number');
    expect(typeof view.profile.dmEnabled).toBe('boolean');
    expect(view.fields.wawuUserId).toBe(USER_CREATOR_BASIC);
    expect(Array.isArray(view.fields.openTo)).toBe(true);
    expect(view.listings).toEqual([]);
    expect(view.name === null || typeof view.name === 'string').toBe(true);
    const byHandle = await visit(userToken, 'chidi-creates').expect(200);
    expect(byHandle.body.data.profile.wawuUserId).toBe(USER_CREATOR_BASIC);
  });

  it('a user sees the same profile and fields the web routes give, so the two cannot disagree', async () => {
    const view = (await visit(userToken, USER_CREATOR_BASIC).expect(200)).body
      .data;
    const profile = await request(app.getHttpServer())
      .get(`/users/${USER_CREATOR_BASIC}/public-profile`)
      .set('Authorization', `Bearer ${userToken}`)
      .expect(200);
    const fields = await request(app.getHttpServer())
      .get(`/users/${USER_CREATOR_BASIC}/profile-fields`)
      .set('Authorization', `Bearer ${userToken}`)
      .expect(200);
    expect(view.profile).toEqual(profile.body.data);
    expect(view.fields).toEqual(fields.body.data);
  });

  it('a user sees Following once they follow, and Follow again once they stop', async () => {
    expect(
      (await visit(userToken, USER_CREATOR_BASIC)).body.data.following,
    ).toBe(false);
    await prisma.followRelationship.create({
      data: { followerWawuId: USER_PLAIN, followingWawuId: USER_CREATOR_BASIC },
    });
    const after = (await visit(userToken, USER_CREATOR_BASIC).expect(200)).body
      .data;
    expect(after.following).toBe(true);
    expect(after.profile.followerCount).toBeGreaterThanOrEqual(1);
    await clean();
    expect(
      (await visit(userToken, USER_CREATOR_BASIC)).body.data.following,
    ).toBe(false);
  });

  it('a creator opening their own profile is told it is their own', async () => {
    const own = await visit(creatorBasicToken, USER_CREATOR_BASIC).expect(200);
    expect(own.body.data.own).toBe(true);
    expect(own.body.data.following).toBe(false);
  });

  it('a user sees only the live listings of the person: approved and shown, never pending or hidden', async () => {
    const live = await listing('ME-02 live', 'technology', true, 'approved');
    await listing('ME-02 hidden', 'legal_services', false, 'approved');
    await listing('ME-02 pending', 'beauty', true, 'pending');
    created.listing = live.id;
    const view = (await visit(userToken, USER_CREATOR_BASIC).expect(200)).body
      .data;
    expect(view.listings).toEqual([
      { id: live.id, headline: 'ME-02 live', category: 'technology' },
    ]);
  });

  it('a user cannot open somebody they blocked, or who blocked them, and the answer does not say which', async () => {
    await prisma.blockedAccount.create({
      data: { userWawuId: USER_PLAIN, blockedWawuId: USER_CREATOR_BASIC },
    });
    const byMe = await visit(userToken, USER_CREATOR_BASIC).expect(404);
    await clean();
    await prisma.blockedAccount.create({
      data: { userWawuId: USER_CREATOR_BASIC, blockedWawuId: USER_PLAIN },
    });
    const byThem = await visit(userToken, USER_CREATOR_BASIC).expect(404);
    expect(byMe.body.message).toBe(byThem.body.message);
    const unknown = await visit(
      userToken,
      '00000000-0000-4000-8000-0000000000ff',
    ).expect(404);
    expect(byMe.body.message).toBe(unknown.body.message);
  });

  it('a user cannot open an account with no public creator profile, and a signed-out caller is refused', async () => {
    await visit(creatorBasicToken, USER_PLAIN).expect(404);
    await request(app.getHttpServer())
      .get(`/users/${USER_CREATOR_BASIC}/visitor-profile`)
      .expect(401);
  });
});
