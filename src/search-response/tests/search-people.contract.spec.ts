import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { SearchResponseModule } from '../search-response.module';
import { MAX_PEOPLE_PER_CALL } from '../dto/search-people-query.dto';

/**
 * EXPLORE-02: GET /search/people, the names the app draws on result rows and
 * "Creators to know". Rows made here carry MARK in their handle or id, so the
 * spec holds on a database other suites have used.
 */
const MARK = 'ex02';
const VIEWER = '00000000-0000-4000-8000-000000000001'; // the mock's Adaeze
const NAMED = '00000000-0000-4000-8000-000000000002'; // the mock's Chidi
const MOCK_ID_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_ID = `http://localhost:${MOCK_ID_PORT}`;
const DAY = 86_400_000;

async function login(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_ID}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) throw new Error(`mock login failed for ${identifier}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

type Person = {
  wawuId: string;
  name: string;
  handle: string | null;
  avatarUrl: string | null;
  field: string | null;
  verification: {
    creator: { verified: boolean };
    professional: { verified: boolean };
  };
  following: boolean;
};

describe('Search people (EXPLORE-02)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let viewer: string;
  // The mock WAWU ID knows NAMED by name. A database that was seeded already
  // holds a profile for them: it is put back as it was, never left changed.
  let seeded: {
    handle: string | null;
    interests: string[];
    accountType: 'creator' | 'user';
    creatorVerifiedAt: Date | null;
    creatorVerifiedUntil: Date | null;
  } | null = null;
  const ids = {
    plain: `${MARK}-p-plain`,
    blocked: `${MARK}-p-blocked`,
    blocker: `${MARK}-p-blocker`,
    off: `${MARK}-p-off`,
    buyer: `${MARK}-p-buyer`,
  };
  const http = () =>
    request(app.getHttpServer() as Parameters<typeof request>[0]);
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const people = async (list: string[], token?: string) => {
    const r = http()
      .get('/api/hub/search/people')
      .query({ ids: list.join(',') });
    const res = await (token ? r.set(auth(token)) : r);
    return {
      status: res.status,
      body: res.body as { data: { items: Person[] } },
    };
  };

  async function cleanUp() {
    const mine = Object.values(ids);
    await prisma.blockedAccount.deleteMany({
      where: {
        OR: [{ userWawuId: { in: mine } }, { blockedWawuId: { in: mine } }],
      },
    });
    await prisma.followRelationship.deleteMany({
      where: {
        followerWawuId: VIEWER,
        followingWawuId: { in: [...mine, NAMED] },
      },
    });
    await prisma.privacySettings.deleteMany({
      where: { userWawuId: { in: mine } },
    });
    await prisma.userProfile.deleteMany({
      where: { handle: { startsWith: MARK }, wawuUserId: { not: NAMED } },
    });
    if (seeded) {
      await prisma.userProfile.update({
        where: { wawuUserId: NAMED },
        data: seeded,
      });
    } else {
      await prisma.userProfile.deleteMany({ where: { wawuUserId: NAMED } });
    }
  }

  beforeAll(async () => {
    viewer = await login('user@test.wawu.dev');
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        SearchResponseModule,
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
    await app.init();
    prisma = app.get(PrismaService);
    seeded = await prisma.userProfile.findUnique({
      where: { wawuUserId: NAMED },
      select: {
        handle: true,
        interests: true,
        accountType: true,
        creatorVerifiedAt: true,
        creatorVerifiedUntil: true,
      },
    });
    await cleanUp();

    const future = new Date(Date.now() + 90 * DAY);
    const make = (
      wawuUserId: string,
      handle: string,
      extra: object = {},
      accountType: 'creator' | 'user' = 'creator',
    ) =>
      prisma.userProfile.upsert({
        where: { wawuUserId },
        create: { wawuUserId, accountType, handle, ...extra },
        update: { accountType, handle, ...extra },
      });
    await make(NAMED, `${MARK}chidi`, {
      interests: ['Wedding films', 'Drone'],
      creatorVerifiedAt: new Date(Date.now() - DAY),
      creatorVerifiedUntil: future,
    });
    await make(ids.plain, `${MARK}plain`);
    await make(ids.blocked, `${MARK}blocked`);
    await make(ids.blocker, `${MARK}blocker`);
    await make(ids.off, `${MARK}off`);
    await make(ids.buyer, `${MARK}buyer`, {}, 'user');
    await prisma.privacySettings.create({
      data: { userWawuId: ids.off, showInMemberLists: false },
    });
    await prisma.blockedAccount.createMany({
      data: [
        { userWawuId: VIEWER, blockedWawuId: ids.blocked },
        { userWawuId: ids.blocker, blockedWawuId: VIEWER },
      ],
    });
    await prisma.followRelationship.create({
      data: { followerWawuId: VIEWER, followingWawuId: NAMED },
    });
  }, 40000);

  afterAll(async () => {
    await cleanUp();
    await app?.close();
  });

  it('names a person from WAWU ID, with their field, tick and whether the caller follows them', async () => {
    const res = await people([NAMED], viewer);
    expect(res.status).toBe(200);
    const [row] = res.body.data.items;
    expect(row.wawuId).toBe(NAMED);
    expect(row.name).toBe('Chidi Umeh');
    expect(row.handle).toBe(`${MARK}chidi`);
    expect(row.field).toBe('Wedding films');
    expect(row.avatarUrl).toBeNull();
    expect(row.verification.creator.verified).toBe(true);
    expect(row.verification.professional.verified).toBe(false);
    expect(row.following).toBe(true);
  });

  it('falls back to the handle when WAWU ID does not know the person, and keeps the order asked', async () => {
    const res = await people([ids.plain, NAMED], viewer);
    expect(res.body.data.items.map((p) => p.wawuId)).toEqual([
      ids.plain,
      NAMED,
    ]);
    expect(res.body.data.items[0].name).toBe(`${MARK}plain`);
    expect(res.body.data.items[0].following).toBe(false);
    expect(res.body.data.items[0].field).toBeNull();
  });

  it('answers following false to someone signed out', async () => {
    const res = await people([NAMED]);
    expect(res.status).toBe(200);
    expect(res.body.data.items[0].following).toBe(false);
  });

  it('leaves out an unknown id, a member who is not a creator, someone blocked either way and someone off member lists', async () => {
    const res = await people(
      [
        `${MARK}-p-nobody`,
        ids.buyer,
        ids.blocked,
        ids.blocker,
        ids.off,
        ids.plain,
      ],
      viewer,
    );
    expect(res.body.data.items.map((p) => p.wawuId)).toEqual([ids.plain]);
    // Signed out, the blocks do not apply, the other rules still do.
    const open = await people([ids.blocked, ids.blocker, ids.off, ids.buyer]);
    expect(open.body.data.items.map((p) => p.wawuId)).toEqual([
      ids.blocked,
      ids.blocker,
    ]);
  });

  it('asks for 1 to 50 accounts, written as ids', async () => {
    const many = Array.from(
      { length: MAX_PEOPLE_PER_CALL + 1 },
      (_, i) => `a${i}`,
    );
    expect((await people(many)).status).toBe(400);
    expect((await people([])).status).toBe(400);
    expect((await http().get('/api/hub/search/people')).status).toBe(400);
    expect(
      (await http().get('/api/hub/search/people').query({ ids: 'a b' })).status,
    ).toBe(400);
    expect(
      (
        await people(
          Array.from({ length: MAX_PEOPLE_PER_CALL }, (_, i) => `a${i}`),
        )
      ).status,
    ).toBe(200);
  });
});
