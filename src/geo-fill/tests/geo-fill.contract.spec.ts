import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { AdminAuthModule } from '../../admin/auth/admin-auth.module';
import { GeoFillModule } from '../geo-fill.module';
import { GeoFillService } from '../geo-fill.service';
import { WawuIdUsersClient } from '../../identity-users/wawu-id-users.client';
import { WawuIdUsersStandIn } from '../../identity-users/tests/wawu-id-users-stand-in';

/**
 * Contract tests for the country fill (GEO-FILL, R-143). WAWU ID's
 * `internal/users/list` is a stand-in (`WawuIdUsersStandIn`).
 *
 * Fixtures: `b3……` ids, swept in afterAll. The stand-in knows only the
 * fixtures, so any other account on a shared database is "unknown" and is left
 * as it is; the assertions that count do so on the fixtures.
 */

const MOCK_WAWU_ID_URL =
  process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';
const USER_PLAIN_EMAIL = 'user@test.wawu.dev';

const ADMIN_IDS = [
  'b3000000-0000-4000-8000-0000000000d1',
  'b3000000-0000-4000-8000-0000000000d2',
  'b3000000-0000-4000-8000-0000000000d3',
  'b3000000-0000-4000-8000-0000000000d4',
];
const ROLES = ['superadmin', 'support', 'finance', 'reviewer'] as const;
const PASSWORD = 'geo-fill-contract-password';

const CHOSEN = 'b3000000-0000-4000-8000-000000000001'; // chose NG; WAWU ID says GB
const BY_CODE = 'b3000000-0000-4000-8000-000000000002'; // WAWU ID GH, phone +234
const BY_PHONE = 'b3000000-0000-4000-8000-000000000003'; // WAWU ID null, phone +44
const NO_ROW_KNOWN = 'b3000000-0000-4000-8000-000000000004'; // no ProfileDetails row, WAWU ID KE
const UNKNOWN = 'b3000000-0000-4000-8000-000000000005'; // WAWU ID has no row
const NO_COUNTRY = 'b3000000-0000-4000-8000-000000000006'; // WAWU ID row, nothing usable
const WITH_REGION = 'b3000000-0000-4000-8000-000000000007'; // empty country row with a stale region
const EARLIER = 'b3000000-0000-4000-8000-000000000008'; // recorded earlier from the phone: left as is
const FIXTURES = [
  CHOSEN,
  BY_CODE,
  BY_PHONE,
  NO_ROW_KNOWN,
  UNKNOWN,
  NO_COUNTRY,
  WITH_REGION,
  EARLIER,
];
const FILLABLE = [BY_CODE, BY_PHONE, NO_ROW_KNOWN, WITH_REGION];

const BULK_PREFIX = 'b3ffffff-0000-4000-8000-';
const bulkId = (i: number) => `${BULK_PREFIX}${String(i).padStart(12, '0')}`;

async function loginToWawuId(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_WAWU_ID_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) throw new Error(`mock-wawu-id login failed: ${res.status}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

describe('Country fill contract (GEO-FILL)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fill: GeoFillService;
  const standIn = new WawuIdUsersStandIn();
  const tokens: Record<string, string> = {};
  let userToken: string;
  const envSnapshot: Record<string, string | undefined> = {};

  const http = () => request(app.getHttpServer());
  const press = (t: string) =>
    http()
      .post('/api/hub/admin/geo/fill-countries')
      .set({ Authorization: `Bearer ${t}` });
  const rows = (ids: string[]) =>
    prisma.profileDetails.findMany({
      where: { wawuUserId: { in: ids } },
      orderBy: { wawuUserId: 'asc' },
    });

  async function clear(): Promise<void> {
    const bulk = { wawuUserId: { startsWith: BULK_PREFIX } };
    await prisma.profileDetails.deleteMany({
      where: { OR: [{ wawuUserId: { in: FIXTURES } }, bulk] },
    });
    await prisma.userProfile.deleteMany({
      where: { OR: [{ wawuUserId: { in: FIXTURES } }, bulk] },
    });
  }

  async function seed(): Promise<void> {
    await clear();
    await prisma.userProfile.createMany({
      data: FIXTURES.map((id) => ({
        wawuUserId: id,
        accountType: 'user' as const,
        interests: [],
      })),
    });
    await prisma.profileDetails.createMany({
      data: [
        {
          wawuUserId: CHOSEN,
          countryCode: 'NG',
          countrySource: 'profile',
          regionCode: 'NG-LA',
          regionName: 'Lagos',
        },
        { wawuUserId: WITH_REGION, regionCode: 'NG-LA', regionName: 'Lagos' },
        { wawuUserId: EARLIER, countryCode: 'FR', countrySource: 'phone' },
      ],
    });
    standIn.users.clear();
    standIn.add({ id: CHOSEN, countryCode: 'GB', phone: '+442079460958' });
    standIn.add({ id: BY_CODE, countryCode: 'GH', phone: '+2348031230001' });
    standIn.add({ id: BY_PHONE, countryCode: null, phone: '+442079460958' });
    standIn.add({ id: NO_ROW_KNOWN, countryCode: 'KE', phone: null });
    standIn.add({ id: NO_COUNTRY, countryCode: null, phone: '08031230001' }); // no country code: says nothing
    standIn.add({ id: WITH_REGION, countryCode: 'NG', phone: null });
    standIn.add({ id: EARLIER, countryCode: 'DE', phone: '+4915112345678' });
    standIn.down = false;
    standIn.idCalls = [];
  }

  beforeAll(async () => {
    for (const key of ['ADMIN_JWT_SECRET', 'ADMIN_JWT_REFRESH_SECRET'])
      envSnapshot[key] = process.env[key];
    process.env.ADMIN_JWT_SECRET = 'geo-fill-access-secret-0123456789abcdef0';
    process.env.ADMIN_JWT_REFRESH_SECRET =
      'geo-fill-refresh-secret-0123456789abcdef';
    userToken = await loginToWawuId(USER_PLAIN_EMAIL);

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        AdminAuthModule,
        GeoFillModule,
      ],
    })
      .overrideProvider(WawuIdUsersClient)
      .useValue(standIn)
      .compile();
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
    prisma = moduleRef.get(PrismaService);
    fill = moduleRef.get(GeoFillService);

    const argon2 = await import('argon2');
    const passwordHash = await argon2.hash(PASSWORD);
    await prisma.adminUser.deleteMany({ where: { id: { in: ADMIN_IDS } } });
    await prisma.adminUser.createMany({
      data: ROLES.map((role, i) => ({
        id: ADMIN_IDS[i],
        email: `fill-${role}@admin.test.wawu.dev`,
        name: `Fill ${role}`,
        role,
        passwordHash,
      })),
    });
    for (const role of ROLES) {
      const res = await http()
        .post('/api/hub/admin/auth/login')
        .send({ email: `fill-${role}@admin.test.wawu.dev`, password: PASSWORD })
        .expect(200);
      tokens[role] = res.body.data.accessToken as string;
    }
  }, 30000);

  beforeEach(seed);

  afterAll(async () => {
    if (prisma) {
      await clear();
      await prisma.adminUser.deleteMany({ where: { id: { in: ADMIN_IDS } } });
    }
    await app?.close();
    for (const [k, v] of Object.entries(envSnapshot)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('is superadmin only', async () => {
    await press(tokens.support).expect(403);
    await press(tokens.finance).expect(403);
    await press(tokens.reviewer).expect(403);
    await http().post('/api/hub/admin/geo/fill-countries').expect(401);
    await press(userToken).expect(401);
    expect(standIn.idCalls).toHaveLength(0);
    await press(tokens.superadmin).expect(200);
  });

  it('answers { checked, filled, alreadyChosen, unknown }', async () => {
    const res = await press(tokens.superadmin).expect(200);
    const d = res.body.data as Record<string, number>;
    expect(Object.keys(d).sort()).toEqual([
      'alreadyChosen',
      'checked',
      'filled',
      'unknown',
    ]);
    expect(d.filled).toBe(FILLABLE.length);
    expect(d.checked).toBe(d.filled + d.alreadyChosen + d.unknown);
    expect(d.alreadyChosen).toBeGreaterThanOrEqual(2); // CHOSEN and EARLIER
    expect(d.unknown).toBeGreaterThanOrEqual(2); // UNKNOWN and NO_COUNTRY
  });

  it('keeps a country a person chose, and never sends it to WAWU ID', async () => {
    await press(tokens.superadmin).expect(200);
    const [chosen] = await rows([CHOSEN]);
    expect(chosen).toMatchObject({
      countryCode: 'NG',
      countrySource: 'profile',
      regionCode: 'NG-LA',
      regionName: 'Lagos',
    });
    expect(standIn.idCalls.flat()).not.toContain(CHOSEN);
  });

  it('takes the WAWU ID country before the phone, then the phone, with the source recorded', async () => {
    await press(tokens.superadmin).expect(200);
    expect((await rows([BY_CODE]))[0]).toMatchObject({
      countryCode: 'GH',
      countrySource: 'wawu_id',
    });
    expect((await rows([BY_PHONE]))[0]).toMatchObject({
      countryCode: 'GB',
      countrySource: 'phone',
    });
    expect((await rows([NO_ROW_KNOWN]))[0]).toMatchObject({
      countryCode: 'KE',
      countrySource: 'wawu_id',
    });
  });

  it('drops a region saved under no country when the country is set', async () => {
    await press(tokens.superadmin).expect(200);
    expect((await rows([WITH_REGION]))[0]).toMatchObject({
      countryCode: 'NG',
      countrySource: 'wawu_id',
      regionCode: null,
      regionName: null,
    });
  });

  it('leaves an account WAWU ID does not know, or that gives no usable country, as it is', async () => {
    await press(tokens.superadmin).expect(200);
    expect(await rows([UNKNOWN, NO_COUNTRY])).toEqual([]);
  });

  it('leaves a country recorded earlier alone', async () => {
    await press(tokens.superadmin).expect(200);
    expect((await rows([EARLIER]))[0]).toMatchObject({
      countryCode: 'FR',
      countrySource: 'phone',
    });
  });

  it('changes nothing the second time', async () => {
    await press(tokens.superadmin).expect(200);
    const after1 = JSON.stringify(await rows(FIXTURES));
    const second = await press(tokens.superadmin).expect(200);
    expect(second.body.data.filled).toBe(0);
    expect(JSON.stringify(await rows(FIXTURES))).toBe(after1);
  });

  it('is safe when two people press it at once: every account is filled once and counted once', async () => {
    const [a, b] = await Promise.all([
      press(tokens.superadmin),
      press(tokens.superadmin),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.data.filled + b.body.data.filled).toBe(FILLABLE.length);
    expect((await rows([BY_CODE]))[0]).toMatchObject({
      countryCode: 'GH',
      countrySource: 'wawu_id',
    });
    expect((await rows([CHOSEN]))[0]).toMatchObject({
      countryCode: 'NG',
      countrySource: 'profile',
    });
    expect(
      await prisma.profileDetails.count({
        where: { wawuUserId: { in: FIXTURES } },
      }),
    ).toBe(
      FIXTURES.length - 2, // UNKNOWN and NO_COUNTRY have no row
    );
  });

  it('asks WAWU ID in batches of 200: 450 accounts are three calls', async () => {
    await prisma.userProfile.createMany({
      data: Array.from({ length: 450 }, (_, i) => ({
        wawuUserId: bulkId(i),
        accountType: 'user' as const,
        interests: [],
      })),
    });
    for (let i = 0; i < 450; i += 1)
      standIn.add({
        id: bulkId(i),
        countryCode: i % 2 === 0 ? 'NG' : null,
        phone: '+233201230002',
      });
    const candidates = (
      await prisma.$queryRaw<Array<{ n: bigint }>>`
        SELECT COUNT(*) AS "n" FROM "UserProfile" p LEFT JOIN "ProfileDetails" d ON d."wawuUserId" = p."wawuUserId"
        WHERE d."countryCode" IS NULL`
    )[0].n;
    const res = await press(tokens.superadmin).expect(200);
    const sizes = standIn.idCalls.map((c) => c.length);
    expect(sizes.reduce((x, y) => x + y, 0)).toBe(Number(candidates));
    expect(sizes.every((n) => n <= 200)).toBe(true);
    expect(sizes).toHaveLength(Math.ceil(Number(candidates) / 200));
    expect(sizes.slice(0, -1).every((n) => n === 200)).toBe(true);
    expect(res.body.data.filled).toBe(FILLABLE.length + 450);
    expect(
      await prisma.profileDetails.count({
        where: {
          wawuUserId: { startsWith: BULK_PREFIX },
          countryCode: { not: null },
        },
      }),
    ).toBe(450);
    const even = await prisma.profileDetails.findUnique({
      where: { wawuUserId: bulkId(0) },
    });
    const odd = await prisma.profileDetails.findUnique({
      where: { wawuUserId: bulkId(1) },
    });
    expect(even).toMatchObject({ countryCode: 'NG', countrySource: 'wawu_id' });
    expect(odd).toMatchObject({ countryCode: 'GH', countrySource: 'phone' });
  }, 60000);

  it('stops with a 502 and writes nothing more when WAWU ID cannot be reached', async () => {
    standIn.down = true;
    const res = await press(tokens.superadmin).expect(502);
    expect(JSON.stringify(res.body)).not.toMatch(/—/);
    expect(await rows([BY_CODE, BY_PHONE, NO_ROW_KNOWN])).toEqual([]);
  });

  describe('by itself', () => {
    it('runs the same fill, and never throws when WAWU ID is down', async () => {
      standIn.down = true;
      await expect(fill.scheduled()).resolves.toBeUndefined();
      expect(await rows([BY_CODE])).toEqual([]);
      standIn.down = false;
      await fill.scheduled();
      expect((await rows([BY_CODE]))[0]).toMatchObject({ countryCode: 'GH' });
    });

    it('does nothing when another server holds the lock', async () => {
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let locked!: () => void;
      const gotLock = new Promise<void>((r) => (locked = r));
      const holder = prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('geo-fill-countries', 0))`;
          locked();
          await held;
        },
        { timeout: 30000 },
      );
      await gotLock;
      try {
        await fill.scheduled();
        expect(standIn.idCalls).toHaveLength(0);
        expect(await rows([BY_CODE])).toEqual([]);
      } finally {
        release();
        await holder;
      }
    });

    it('is not started by a spec that boots the module', () => {
      expect(process.env.JEST_WORKER_ID).toBeDefined();
      expect(standIn.idCalls).toHaveLength(0);
    });
  });
});
