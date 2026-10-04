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

import {
  LOCATION_MAX_LENGTH,
  OPEN_TO_MAX_COUNT,
  OPEN_TO_MAX_LENGTH,
  SKILLS_MAX_COUNT,
  SKILL_MAX_LENGTH,
  THREADS_HANDLE_MAX_LENGTH,
} from '../profile-fields';

/**
 * ME-05: the profile fields M1, M4, M5, M8, M9 and M33 show, on their own
 * routes. Written as what a user can do.
 */
describe('Profile fields (ME-05, contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mockWawuId: ChildProcess | undefined;
  let ownedMockWawuId = false;
  let userToken: string;
  let creatorBasicToken: string;

  const FIELDS = {
    location: 'Lagos, Nigeria',
    skills: ['Directing', 'Colour grading'],
    openTo: ['Brand films', 'Workshops'],
    threadsHandle: 'lennox',
    socialOrder: ['tiktok', 'instagram', 'threads'],
  };

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

  afterAll(async () => {
    await prisma.profileDetails.deleteMany({
      where: { wawuUserId: { in: [USER_CREATOR_BASIC, USER_PLAIN] } },
    });
    await app?.close();
    if (ownedMockWawuId && mockWawuId) mockWawuId.kill();
  });

  beforeEach(async () => {
    await prisma.profileDetails.deleteMany({
      where: { wawuUserId: { in: [USER_CREATOR_BASIC, USER_PLAIN] } },
    });
  });

  const save = (token: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .patch('/users/me/profile-fields')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  const readMine = (token: string) =>
    request(app.getHttpServer())
      .get('/users/me/profile-fields')
      .set('Authorization', `Bearer ${token}`);
  const readOf = (token: string, who: string) =>
    request(app.getHttpServer())
      .get(`/users/${who}/profile-fields`)
      .set('Authorization', `Bearer ${token}`);

  it('a user can save location, skills, open to, Threads and social order and read them back on their own profile', async () => {
    const saved = await save(creatorBasicToken, FIELDS).expect(200);
    expect(saved.body.data).toEqual(expect.objectContaining(FIELDS));
    const mine = await readMine(creatorBasicToken).expect(200);
    expect(mine.body.data).toEqual(expect.objectContaining(FIELDS));
  });

  it("a user can see another user's saved fields (M8 to M5), by id and by handle", async () => {
    await save(creatorBasicToken, FIELDS).expect(200);
    const byId = await readOf(userToken, USER_CREATOR_BASIC).expect(200);
    expect(byId.body.data).toEqual(
      expect.objectContaining({ wawuUserId: USER_CREATOR_BASIC, ...FIELDS }),
    );
    const byHandle = await readOf(userToken, 'chidi-creates').expect(200);
    expect(byHandle.body.data).toEqual(expect.objectContaining(FIELDS));
  });

  it('a user can see how long someone has been a member, the same for the owner and a visitor', async () => {
    const created = (
      await prisma.userProfile.findUniqueOrThrow({
        where: { wawuUserId: USER_CREATOR_BASIC },
      })
    ).createdAt.toISOString();
    expect((await readMine(creatorBasicToken)).body.data.memberSince).toBe(
      created,
    );
    expect(
      (await readOf(userToken, USER_CREATOR_BASIC)).body.data.memberSince,
    ).toBe(created);
  });

  it('a user who has set nothing gets empty fields, not an error', async () => {
    const mine = await readMine(creatorBasicToken).expect(200);
    expect(mine.body.data).toEqual(
      expect.objectContaining({
        location: null,
        skills: [],
        openTo: [],
        threadsHandle: null,
        socialOrder: [],
      }),
    );
  });

  it('a user cannot read the fields of an account with no public profile, or one that does not exist', async () => {
    await readOf(userToken, USER_PLAIN).expect(404);
    await readOf(userToken, '00000000-0000-4000-8000-0000000000ff').expect(404);
    await request(app.getHttpServer())
      .get(`/users/${USER_CREATOR_BASIC}/profile-fields`)
      .expect(401);
    await request(app.getHttpServer())
      .get('/users/me/profile-fields')
      .expect(401);
    await request(app.getHttpServer())
      .patch('/users/me/profile-fields')
      .send({})
      .expect(401);
  });

  it('a user who saves some fields leaves the others as they were', async () => {
    await save(creatorBasicToken, FIELDS).expect(200);
    await save(creatorBasicToken, { location: 'Abuja' }).expect(200);
    const mine = await readMine(creatorBasicToken).expect(200);
    expect(mine.body.data).toEqual(
      expect.objectContaining({ ...FIELDS, location: 'Abuja' }),
    );
  });

  it('a user can save fields without having a profile row, and no profile row or wallet is made', async () => {
    const before = await prisma.userProfile.count();
    await save(userToken, { location: 'Kano' }).expect(200);
    expect(await prisma.userProfile.count()).toBe(before);
  });

  it('a user can clear location, Threads, skills, open to and the order', async () => {
    await save(creatorBasicToken, FIELDS).expect(200);
    await save(creatorBasicToken, {
      location: '',
      threadsHandle: null,
      skills: [],
      openTo: [],
      socialOrder: [],
    }).expect(200);
    const mine = await readMine(creatorBasicToken).expect(200);
    expect(mine.body.data).toEqual(
      expect.objectContaining({
        location: null,
        threadsHandle: null,
        skills: [],
        openTo: [],
        socialOrder: [],
      }),
    );
  });

  it('a user can type their Threads handle with an @ and it is saved without one', async () => {
    const saved = await save(creatorBasicToken, {
      threadsHandle: '  @lennox  ',
    }).expect(200);
    expect(saved.body.data.threadsHandle).toBe('lennox');
  });

  it('a user can type skills with spaces and repeats and they are saved trimmed, once each, in the order typed', async () => {
    const saved = await save(creatorBasicToken, {
      skills: ['  Directing ', 'directing', '', 'Editing'],
    }).expect(200);
    expect(saved.body.data.skills).toEqual(['Directing', 'Editing']);
  });

  it('a user can set an order that includes every platform M9 lists', async () => {
    const all = [
      'facebook',
      'linkedin',
      'threads',
      'x',
      'youtube',
      'tiktok',
      'instagram',
    ];
    const saved = await save(creatorBasicToken, { socialOrder: all }).expect(
      200,
    );
    expect(saved.body.data.socialOrder).toEqual(all);
  });

  it('a user cannot save a value longer than the limit, or too many chips', async () => {
    await save(creatorBasicToken, {
      location: 'x'.repeat(LOCATION_MAX_LENGTH + 1),
    }).expect(400);
    await save(creatorBasicToken, {
      skills: ['x'.repeat(SKILL_MAX_LENGTH + 1)],
    }).expect(400);
    await save(creatorBasicToken, {
      skills: Array.from({ length: SKILLS_MAX_COUNT + 1 }, (_, i) => `s${i}`),
    }).expect(400);
    await save(creatorBasicToken, {
      openTo: ['x'.repeat(OPEN_TO_MAX_LENGTH + 1)],
    }).expect(400);
    await save(creatorBasicToken, {
      openTo: Array.from({ length: OPEN_TO_MAX_COUNT + 1 }, (_, i) => `o${i}`),
    }).expect(400);
    await save(creatorBasicToken, {
      threadsHandle: 'x'.repeat(THREADS_HANDLE_MAX_LENGTH + 1),
    }).expect(400);
    expect((await readMine(creatorBasicToken)).body.data.location).toBeNull();
  });

  it('a user cannot save an unknown platform, a repeated one, or the wrong type', async () => {
    await save(creatorBasicToken, { socialOrder: ['myspace'] }).expect(400);
    await save(creatorBasicToken, {
      socialOrder: ['threads', 'threads'],
    }).expect(400);
    await save(creatorBasicToken, { socialOrder: 'threads' }).expect(400);
    await save(creatorBasicToken, { skills: 'Directing' }).expect(400);
    await save(creatorBasicToken, { location: 42 }).expect(400);
    await save(creatorBasicToken, { unknownKey: 1 }).expect(400);
  });

  it('a signed-in user still gets exactly the old keys on GET /users/me and the public profile', async () => {
    await save(creatorBasicToken, FIELDS).expect(200);
    const me = await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${creatorBasicToken}`)
      .expect(200);
    const pub = await readPublicProfile();
    for (const k of [
      'location',
      'skills',
      'openTo',
      'threadsHandle',
      'socialOrder',
      'memberSince',
    ]) {
      expect(me.body.data).not.toHaveProperty(k);
      expect(pub.body.data).not.toHaveProperty(k);
    }
  });

  function readPublicProfile() {
    return request(app.getHttpServer())
      .get(`/users/${USER_CREATOR_BASIC}/public-profile`)
      .set('Authorization', `Bearer ${userToken}`)
      .expect(200);
  }
});
