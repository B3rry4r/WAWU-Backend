// EXPLORE-03: Explore's categories and featured creators.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AdminAuthModule } from '../../admin/auth/admin-auth.module';
import { AdminFeaturedCreatorsModule } from '../../admin/featured-creators/admin-featured-creators.module';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ExploreModule } from '../explore.module';

const PLAIN = '00000000-0000-4000-8000-000000000001'; // the viewer
const CHIDI = '00000000-0000-4000-8000-000000000002'; // creator, 1 live piece
const ZAINAB = '00000000-0000-4000-8000-000000000003'; // creator, 2 live pieces
const SUPER_ID = 'ad030000-0000-4000-8000-000000000001';
const REVIEWER_ID = 'ad030000-0000-4000-8000-000000000002';
const SUPER_EMAIL = 'e03-super@admin.test.wawu.dev';
const REVIEWER_EMAIL = 'e03-reviewer@admin.test.wawu.dev';
const PASSWORD = 'explore-contract-password';

const MOCK_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_BASE = `http://localhost:${MOCK_PORT}`;

async function waitForHealth(url: string, timeoutMs = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function login(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) throw new Error(`mock login failed for ${identifier}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

describe('Explore categories and featured creators (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mock: ChildProcess | undefined;
  let plain: string;
  let superToken: string;
  let reviewerToken: string;
  const saved: Record<string, string[]> = {};
  const savedEnv: Record<string, string | undefined> = {};
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  const cards = async (url: string, token?: string) => {
    const r = http().get(url);
    const res = await (token ? r.set(bearer(token)) : r).expect(200);
    return res.body as {
      data: Array<{ wawuId: string }> | { items: Array<{ wawuId: string }> };
      pagination?: { total: number };
    };
  };
  const ids = async (url: string, token?: string) =>
    (() => {
      return cards(url, token).then((b) =>
        (Array.isArray(b.data) ? b.data : b.data.items).map((i) => i.wawuId),
      );
    })();
  const feature = (id: string, body: object = {}) =>
    http()
      .put(`/api/hub/admin/featured-creators/${id}`)
      .set(bearer(superToken))
      .send(body);
  const clearBlocks = () =>
    prisma.blockedAccount.deleteMany({
      where: { userWawuId: { in: [PLAIN, CHIDI, ZAINAB] } },
    });

  beforeAll(async () => {
    if (!(await waitForHealth(`${MOCK_BASE}/health`, 1000))) {
      mock = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '../../../mock-wawu-id'),
        env: { ...process.env, MOCK_WAWU_ID_PORT: MOCK_PORT },
        stdio: 'ignore',
      });
      if (!(await waitForHealth(`${MOCK_BASE}/health`))) {
        throw new Error('mock-wawu-id did not come up');
      }
    }
    plain = await login('user@test.wawu.dev');
    for (const k of ['ADMIN_JWT_SECRET', 'ADMIN_JWT_REFRESH_SECRET'])
      savedEnv[k] = process.env[k];
    process.env.ADMIN_JWT_SECRET = 'explore-access-secret-0123456789abcdef01';
    process.env.ADMIN_JWT_REFRESH_SECRET =
      'explore-refresh-secret-0123456789abcdef0';

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        AdminAuthModule,
        ExploreModule,
        AdminFeaturedCreatorsModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/hub');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.listen(0);
    prisma = app.get(PrismaService);

    for (const id of [CHIDI, ZAINAB]) {
      const p = await prisma.userProfile.findUniqueOrThrow({
        where: { wawuUserId: id },
        select: { interests: true },
      });
      saved[id] = p.interests;
    }
    await prisma.userProfile.update({
      where: { wawuUserId: CHIDI },
      data: { interests: ['Film & Video', 'makeup'] },
    });
    await prisma.userProfile.update({
      where: { wawuUserId: ZAINAB },
      data: { interests: ['photography'] },
    });

    const argon2 = await import('argon2');
    const passwordHash = await argon2.hash(PASSWORD);
    await prisma.adminUser.deleteMany({
      where: { email: { in: [SUPER_EMAIL, REVIEWER_EMAIL] } },
    });
    await prisma.adminUser.createMany({
      data: [
        {
          id: SUPER_ID,
          email: SUPER_EMAIL,
          passwordHash,
          name: 'E03 Super',
          role: 'superadmin',
        },
        {
          id: REVIEWER_ID,
          email: REVIEWER_EMAIL,
          passwordHash,
          name: 'E03 Reviewer',
          role: 'reviewer',
        },
      ],
    });
    const adminLogin = async (email: string) =>
      (
        (
          await http()
            .post('/api/hub/admin/auth/login')
            .send({ email, password: PASSWORD })
            .expect(200)
        ).body as { data: { accessToken: string } }
      ).data.accessToken;
    superToken = await adminLogin(SUPER_EMAIL);
    reviewerToken = await adminLogin(REVIEWER_EMAIL);
    await clearBlocks();
    await prisma.featuredCreator.deleteMany({});
  }, 60_000);

  afterAll(async () => {
    await clearBlocks();
    await prisma.privacySettings.deleteMany({
      where: { userWawuId: { in: [CHIDI, ZAINAB] } },
    });
    await prisma.featuredCreator.deleteMany({});
    for (const [id, interests] of Object.entries(saved)) {
      await prisma.userProfile.update({
        where: { wawuUserId: id },
        data: { interests },
      });
    }
    await prisma.adminUser.deleteMany({
      where: { id: { in: [SUPER_ID, REVIEWER_ID] } },
    });
    await app.close();
    mock?.kill();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('a user can see the creator categories the chips show, with Film & Video among them', async () => {
    const res = await http().get('/api/hub/explore/categories').expect(200);
    const items = (
      res.body as { data: { items: Array<{ id: string; label: string }> } }
    ).data.items;
    expect(items).toHaveLength(12);
    expect(items).toContainEqual({ id: 'film_video', label: 'Film & Video' });
  });

  it("a user who chooses 'Film & Video' sees only creators in it", async () => {
    expect(await ids('/api/hub/explore/creators?category=film_video')).toEqual([
      CHIDI,
    ]);
    expect(
      await ids('/api/hub/explore/creators?category=photography', plain),
    ).toEqual([ZAINAB]);
    expect(await ids('/api/hub/explore/creators?category=music_audio')).toEqual(
      [],
    );
    const all = await ids('/api/hub/explore/creators');
    expect([...all].sort()).toEqual([CHIDI, ZAINAB].sort());
    const one = await cards('/api/hub/explore/creators?category=film_video');
    expect(one.pagination?.total).toBe(1);
  });

  it('a user gets a 400, never a 500, for hostile category, page and limit values', async () => {
    const bad = [
      'category=Film%20%26%20Video',
      'category=nope',
      'category=%00',
      'category=film_video&category=photography',
      'category[]=film_video',
      'category=%ED%A0%80',
      'page=0',
      'page=-1',
      'page=1e20',
      'page=abc',
      'page=1.5',
      'perPage=0',
      'perPage=51',
      'perPage=Infinity',
      'unknown=1',
    ];
    for (const q of bad) {
      const res = await http().get(`/api/hub/explore/creators?${q}`);
      expect([q, res.status]).toEqual([q, 400]);
    }
    for (const q of ['limit=0', 'limit=21', 'limit=x', 'limit=%00', 'a=b']) {
      const res = await http().get(`/api/hub/explore/featured-creators?${q}`);
      expect([q, res.status]).toEqual([q, 400]);
    }
  });

  it('a user sees no featured creators until an admin features one, then in the admin order', async () => {
    expect(await ids('/api/hub/explore/featured-creators')).toEqual([]);
    await feature(CHIDI, { position: 5 }).expect(200);
    await feature(ZAINAB, { position: 1 }).expect(200);
    expect(await ids('/api/hub/explore/featured-creators', plain)).toEqual([
      ZAINAB,
      CHIDI,
    ]);
    expect(await ids('/api/hub/explore/featured-creators?limit=1')).toEqual([
      ZAINAB,
    ]);
    await feature(CHIDI, { position: 0 }).expect(200);
    expect(await ids('/api/hub/explore/featured-creators')).toEqual([
      CHIDI,
      ZAINAB,
    ]);
    await http()
      .delete(`/api/hub/admin/featured-creators/${CHIDI}`)
      .set(bearer(superToken))
      .expect(200);
    expect(await ids('/api/hub/explore/featured-creators')).toEqual([ZAINAB]);
    await http()
      .delete(`/api/hub/admin/featured-creators/${CHIDI}`)
      .set(bearer(superToken))
      .expect(200);
  });

  it('a user never sees a creator they blocked, or who blocked them, in featured or a category, nor in the total', async () => {
    await feature(ZAINAB).expect(200);
    const urls = [
      '/api/hub/explore/featured-creators',
      '/api/hub/explore/creators?category=photography',
      '/api/hub/explore/creators',
    ];
    for (const url of urls) expect(await ids(url, plain)).toContain(ZAINAB);
    for (const blocker of [
      { userWawuId: PLAIN, blockedWawuId: ZAINAB },
      { userWawuId: ZAINAB, blockedWawuId: PLAIN },
    ]) {
      await clearBlocks();
      await prisma.blockedAccount.create({ data: blocker });
      for (const url of urls)
        expect(await ids(url, plain)).not.toContain(ZAINAB);
      const cat = await cards(
        '/api/hub/explore/creators?category=photography',
        plain,
      );
      expect(cat.pagination?.total).toBe(0);
      // Identical to a creator who is not there at all: another viewer still sees her.
      expect(await ids('/api/hub/explore/featured-creators')).toContain(ZAINAB);
    }
    await clearBlocks();
    expect(await ids('/api/hub/explore/featured-creators', plain)).toContain(
      ZAINAB,
    );
  });

  it('a user does not see a creator whose profile is not public, in featured or a category', async () => {
    await feature(ZAINAB).expect(200);
    await prisma.privacySettings.upsert({
      where: { userWawuId: ZAINAB },
      create: { userWawuId: ZAINAB, showInMemberLists: false },
      update: { showInMemberLists: false },
    });
    expect(await ids('/api/hub/explore/featured-creators')).not.toContain(
      ZAINAB,
    );
    expect(await ids('/api/hub/explore/creators?category=photography')).toEqual(
      [],
    );
    await prisma.privacySettings.deleteMany({ where: { userWawuId: ZAINAB } });
    expect(await ids('/api/hub/explore/featured-creators')).toContain(ZAINAB);
  });

  it('a user does not see a featured creator who has nothing live to browse', async () => {
    await feature(ZAINAB).expect(200);
    await prisma.contentPiece.updateMany({
      where: { creatorWawuId: ZAINAB, status: 'live' },
      data: { status: 'pending' },
    });
    try {
      expect(await ids('/api/hub/explore/featured-creators')).not.toContain(
        ZAINAB,
      );
    } finally {
      await prisma.contentPiece.updateMany({
        where: { creatorWawuId: ZAINAB, status: 'pending' },
        data: { status: 'live' },
      });
    }
    expect(await ids('/api/hub/explore/featured-creators')).toContain(ZAINAB);
  });

  it('only a superadmin can feature a creator, and only a real creator', async () => {
    const url = `/api/hub/admin/featured-creators/${CHIDI}`;
    await http().put(url).send({}).expect(401);
    await http().put(url).set(bearer(plain)).send({}).expect(401);
    await http().put(url).set(bearer(reviewerToken)).send({}).expect(403);
    await http().delete(url).set(bearer(reviewerToken)).expect(403);
    await http().delete(url).expect(401);
    await feature(PLAIN).expect(404); // an account that is not a creator
    await feature('00000000-0000-4000-8000-0000000000ff').expect(404);
    await feature('%00').expect(404);
    await feature('a'.repeat(200)).expect(404);
    for (const body of [
      { position: -1 },
      { position: 1001 },
      { position: 'x' },
      { position: 1.5 },
      { extra: 1 },
    ]) {
      await feature(CHIDI, body).expect(400);
    }
    expect(
      await prisma.featuredCreator.count({
        where: { wawuUserId: { in: [PLAIN, CHIDI] } },
      }),
    ).toBe(0);
  });

  it('two admins featuring the same creator at once leave one row', async () => {
    const results = await Promise.all(
      Array.from({ length: 16 }, (_, i) => feature(CHIDI, { position: i })),
    );
    expect(results.map((r) => r.status)).toEqual(Array(16).fill(200));
    expect(
      await prisma.featuredCreator.count({ where: { wawuUserId: CHIDI } }),
    ).toBe(1);
  });
});
