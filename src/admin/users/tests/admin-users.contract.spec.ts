import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { AdminAuthModule } from '../../auth/admin-auth.module';
import { AdminUsersModule } from '../admin-users.module';
import { lagosDayStart } from '../admin-users.service';
import { WawuIdUsersClient } from '../../../identity-users/wawu-id-users.client';
import { WawuIdUsersStandIn } from '../../../identity-users/tests/wawu-id-users-stand-in';

/**
 * Contract tests for the dashboard's Users page (USERS-DASH, R-142).
 * WAWU ID's `internal/users/list` is a stand-in (`WawuIdUsersStandIn`), the way
 * the other WAWU ID calls are stood in for in this repo's specs.
 *
 * Fixtures live under this suite's own `b2……` id prefix and are swept in
 * afterAll. Their join dates are in 2099 so they head the newest-first list on
 * a shared database.
 */

const MOCK_WAWU_ID_URL =
  process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';
const USER_PLAIN_EMAIL = 'user@test.wawu.dev';

const ADMIN_SUPER_ID = 'b2000000-0000-4000-8000-0000000000d1';
const ADMIN_SUPPORT_ID = 'b2000000-0000-4000-8000-0000000000d2';
const ADMIN_FINANCE_ID = 'b2000000-0000-4000-8000-0000000000d3';
const ADMIN_REVIEWER_ID = 'b2000000-0000-4000-8000-0000000000d4';
const ADMIN_IDS = [
  ADMIN_SUPER_ID,
  ADMIN_SUPPORT_ID,
  ADMIN_FINANCE_ID,
  ADMIN_REVIEWER_ID,
];
const PASSWORD = 'admin-users-contract-password';
const TEST_ACCESS_SECRET = 'admin-users-access-secret-0123456789abcdef';
const TEST_REFRESH_SECRET = 'admin-users-refresh-secret-0123456789abcdef';

const ADA = 'b2000000-0000-4000-8000-000000000001'; // creator, tick, wallet, Nigeria chosen
const BOLA = 'b2000000-0000-4000-8000-000000000002'; // user, suspended, Ghana from wawu_id
const CHIDI = 'b2000000-0000-4000-8000-000000000003'; // user, lapsed tick, lifted suspension, no country
const DELE = 'b2000000-0000-4000-8000-000000000004'; // creator, no WAWU ID row, Nuvion wallet only
const EKE = 'b2000000-0000-4000-8000-000000000005'; // user, phone-sourced country
const GHOST = 'b2000000-0000-4000-8000-0000000000aa'; // in WAWU ID only: no Hub account
const FIXTURES = [ADA, BOLA, CHIDI, DELE, EKE];
const STEM = 'ctrctusers';

const EMAIL_ADA = 'ada.ctrct@example.test';
const PHONE_ADA = '+2348031230001';
const EMAIL_GHOST = 'ghost.ctrct@example.test';

async function loginToWawuId(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_WAWU_ID_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) throw new Error(`mock-wawu-id login failed: ${res.status}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

describe('Admin users list contract (USERS-DASH)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const standIn = new WawuIdUsersStandIn();
  let superToken: string;
  let supportToken: string;
  let financeToken: string;
  let reviewerToken: string;
  let userToken: string;
  const envSnapshot: Record<string, string | undefined> = {};

  const http = () => request(app.getHttpServer());
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const list = (t: string, query: Record<string, unknown> = {}) =>
    http().get('/api/hub/admin/users').query(query).set(auth(t));

  async function adminLogin(email: string): Promise<string> {
    const res = await http()
      .post('/api/hub/admin/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return res.body.data.accessToken as string;
  }

  async function clear(): Promise<void> {
    await prisma.userSuspension.deleteMany({
      where: { wawuUserId: { in: FIXTURES } },
    });
    await prisma.fintavaWallet.deleteMany({
      where: { wawuUserId: { in: FIXTURES } },
    });
    await prisma.profileDetails.deleteMany({
      where: { wawuUserId: { in: FIXTURES } },
    });
    await prisma.userProfile.deleteMany({
      where: { wawuUserId: { in: FIXTURES } },
    });
  }

  async function seed(): Promise<void> {
    await clear();
    const future = new Date('2099-01-01T00:00:00.000Z');
    const past = new Date('2020-01-01T00:00:00.000Z');
    await prisma.userProfile.createMany({
      data: [
        {
          wawuUserId: ADA,
          accountType: 'creator',
          handle: `${STEM}-Ada`,
          interests: [],
          createdAt: new Date('2099-05-01T00:00:00.000Z'),
          creatorVerifiedAt: past,
          creatorVerifiedUntil: future,
        },
        {
          wawuUserId: BOLA,
          accountType: 'user',
          handle: `${STEM}-bola`,
          interests: [],
          createdAt: new Date('2099-04-01T00:00:00.000Z'),
        },
        {
          wawuUserId: CHIDI,
          accountType: 'user',
          handle: null,
          interests: [],
          createdAt: new Date('2099-03-01T00:00:00.000Z'),
          professionalVerifiedAt: past,
          professionalVerifiedUntil: new Date('2021-01-01T00:00:00.000Z'),
        },
        {
          wawuUserId: DELE,
          accountType: 'creator',
          handle: `${STEM}-dele`,
          interests: [],
          createdAt: new Date('2099-02-01T00:00:00.000Z'),
        },
        {
          wawuUserId: EKE,
          accountType: 'user',
          handle: `${STEM}-eke`,
          interests: [],
          createdAt: new Date('2099-01-15T00:00:00.000Z'),
        },
      ],
    });
    await prisma.profileDetails.createMany({
      data: [
        { wawuUserId: ADA, countryCode: 'NG', countrySource: 'profile' },
        { wawuUserId: BOLA, countryCode: 'GH', countrySource: 'wawu_id' },
        { wawuUserId: EKE, countryCode: 'GB', countrySource: 'phone' },
      ],
    });
    await prisma.fintavaWallet.createMany({
      data: [
        {
          wawuUserId: ADA,
          customerId: 'ctrct-users-cust-ada',
          walletId: 'ctrct-users-wal-ada',
          accountNumber: '9000000001',
          provider: 'fintava',
        },
        {
          wawuUserId: DELE,
          customerId: 'ctrct-users-cust-dele',
          walletId: 'ctrct-users-wal-dele',
          accountNumber: '9000000002',
          provider: 'nuvion',
        },
      ],
    });
    await prisma.userSuspension.createMany({
      data: [
        {
          wawuUserId: BOLA,
          reason: 'spam',
          suspendedByAdminId: ADMIN_SUPER_ID,
          suspendedByAdminEmail: 'x@admin.test',
          suspendedByAdminRole: 'superadmin',
        },
        {
          wawuUserId: CHIDI,
          reason: 'spam',
          suspendedByAdminId: ADMIN_SUPER_ID,
          suspendedByAdminEmail: 'x@admin.test',
          suspendedByAdminRole: 'superadmin',
          liftedAt: new Date(),
          liftedByAdminId: ADMIN_SUPER_ID,
          liftedByAdminEmail: 'x@admin.test',
          liftedByAdminRole: 'superadmin',
        },
      ],
    });
    standIn.users.clear();
    standIn.add({
      id: ADA,
      firstName: 'Ada',
      lastName: 'Eze',
      email: EMAIL_ADA,
      phone: PHONE_ADA,
    });
    standIn.add({
      id: BOLA,
      firstName: 'Bola',
      lastName: 'Adaobi',
      email: 'bola.ctrct@example.test',
      phone: '+233201230002',
    });
    standIn.add({
      id: CHIDI,
      firstName: 'Chidi',
      lastName: 'Okoro',
      email: null,
      phone: '+2348031230003',
    });
    standIn.add({
      id: EKE,
      firstName: 'Eke',
      lastName: 'Bull',
      email: 'eke.ctrct@example.test',
      phone: '+447911123456',
    });
    // DELE: no WAWU ID row. GHOST: WAWU ID row, no Hub account.
    standIn.add({
      id: GHOST,
      firstName: 'Ada',
      lastName: 'Ghost',
      email: EMAIL_GHOST,
      phone: '+2348031239999',
    });
    standIn.down = false;
    standIn.idCalls = [];
    standIn.searchCalls = [];
  }

  beforeAll(async () => {
    for (const key of ['ADMIN_JWT_SECRET', 'ADMIN_JWT_REFRESH_SECRET'])
      envSnapshot[key] = process.env[key];
    process.env.ADMIN_JWT_SECRET = TEST_ACCESS_SECRET;
    process.env.ADMIN_JWT_REFRESH_SECRET = TEST_REFRESH_SECRET;
    userToken = await loginToWawuId(USER_PLAIN_EMAIL);

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        AdminAuthModule,
        AdminUsersModule,
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

    const argon2 = await import('argon2');
    const passwordHash = await argon2.hash(PASSWORD);
    await prisma.adminUser.deleteMany({ where: { id: { in: ADMIN_IDS } } });
    await prisma.adminUser.createMany({
      data: [
        {
          id: ADMIN_SUPER_ID,
          email: 'users-super@admin.test.wawu.dev',
          name: 'Users Super',
          role: 'superadmin',
          passwordHash,
        },
        {
          id: ADMIN_SUPPORT_ID,
          email: 'users-support@admin.test.wawu.dev',
          name: 'Users Support',
          role: 'support',
          passwordHash,
        },
        {
          id: ADMIN_FINANCE_ID,
          email: 'users-finance@admin.test.wawu.dev',
          name: 'Users Finance',
          role: 'finance',
          passwordHash,
        },
        {
          id: ADMIN_REVIEWER_ID,
          email: 'users-reviewer@admin.test.wawu.dev',
          name: 'Users Reviewer',
          role: 'reviewer',
          passwordHash,
        },
      ],
    });
    superToken = await adminLogin('users-super@admin.test.wawu.dev');
    supportToken = await adminLogin('users-support@admin.test.wawu.dev');
    financeToken = await adminLogin('users-finance@admin.test.wawu.dev');
    reviewerToken = await adminLogin('users-reviewer@admin.test.wawu.dev');
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

  describe('roles', () => {
    it.each(['/api/hub/admin/users', '/api/hub/admin/users/counts'])(
      'superadmin and support read %s; finance and reviewer are refused',
      async (path) => {
        await http().get(path).set(auth(superToken)).expect(200);
        await http().get(path).set(auth(supportToken)).expect(200);
        await http().get(path).set(auth(financeToken)).expect(403);
        await http().get(path).set(auth(reviewerToken)).expect(403);
      },
    );

    it('refuses no token and a WAWU ID user token with 401', async () => {
      await http().get('/api/hub/admin/users').expect(401);
      await http().get('/api/hub/admin/users').set(auth(userToken)).expect(401);
      await http()
        .get('/api/hub/admin/users/counts')
        .set(auth(userToken))
        .expect(401);
    });

    it('gives finance the same refusal the creators lookup gives a role it does not allow', async () => {
      const res = await list(financeToken).expect(403);
      expect(res.body.statusCode).toBe(403);
    });
  });

  describe('GET /admin/users', () => {
    it('lists newest first by the Hub profile date, with every field and contacts joined by id', async () => {
      const res = await list(supportToken, { perPage: 5 }).expect(200);
      expect(res.body).toMatchObject({
        statusCode: 200,
        message: 'OK',
        contactUnavailable: false,
      });
      const items = res.body.data as Array<Record<string, unknown>>;
      expect(items.map((i) => i.wawuId)).toEqual([ADA, BOLA, CHIDI, DELE, EKE]);
      const ada = items[0];
      expect(Object.keys(ada).sort()).toEqual(
        [
          'wawuId',
          'firstName',
          'lastName',
          'handle',
          'email',
          'phone',
          'countryCode',
          'countryName',
          'countrySource',
          'accountType',
          'joinedAt',
          'tickHeld',
          'walletOpened',
          'suspended',
        ].sort(),
      );
      expect(ada).toMatchObject({
        firstName: 'Ada',
        lastName: 'Eze',
        handle: `${STEM}-Ada`,
        email: EMAIL_ADA,
        phone: PHONE_ADA,
        countryCode: 'NG',
        countryName: 'Nigeria',
        countrySource: 'profile',
        accountType: 'creator',
        joinedAt: '2099-05-01T00:00:00.000Z',
      });
      // One WAWU ID call for the page, carrying that page's ids and nothing else.
      expect(standIn.idCalls).toHaveLength(1);
      expect(standIn.idCalls[0].sort()).toEqual(
        items.map((i) => i.wawuId as string).sort(),
      );
      expect(res.body.pagination).toMatchObject({ currentPage: 1, perPage: 5 });
    });

    it('takes each flag from its own source', async () => {
      const res = await list(superToken, { perPage: 5 }).expect(200);
      const by = (id: string) =>
        (res.body.data as Array<Record<string, unknown>>).find(
          (i) => i.wawuId === id,
        )!;
      // tick: a held tick, a lapsed one, none.
      expect(by(ADA).tickHeld).toBe(true);
      expect(by(CHIDI).tickHeld).toBe(false);
      expect(by(BOLA).tickHeld).toBe(false);
      // wallet: a row of the provider this server runs (fintava by default); a nuvion row is not.
      expect(by(ADA).walletOpened).toBe(true);
      expect(by(DELE).walletOpened).toBe(false);
      // suspended: in force, lifted, never.
      expect(by(BOLA).suspended).toBe(true);
      expect(by(CHIDI).suspended).toBe(false);
      expect(by(ADA).suspended).toBe(false);
      // country source: chosen, wawu_id, phone, none.
      expect(by(ADA).countrySource).toBe('profile');
      expect(by(BOLA)).toMatchObject({
        countryCode: 'GH',
        countryName: 'Ghana',
        countrySource: 'wawu_id',
      });
      expect(by(EKE)).toMatchObject({
        countryCode: 'GB',
        countrySource: 'phone',
      });
      expect(by(CHIDI)).toMatchObject({
        countryCode: null,
        countryName: null,
        countrySource: null,
      });
    });

    it('opens a person WAWU ID has no row for, with contact fields null and no warning', async () => {
      const res = await list(superToken, { perPage: 5 }).expect(200);
      const dele = (res.body.data as Array<Record<string, unknown>>).find(
        (i) => i.wawuId === DELE,
      )!;
      expect(dele).toMatchObject({
        firstName: null,
        lastName: null,
        email: null,
        phone: null,
        handle: `${STEM}-dele`,
      });
      expect(res.body.contactUnavailable).toBe(false);
    });

    it('answers 200 with the Hub fields and contactUnavailable when WAWU ID cannot be reached, and logs no contact', async () => {
      standIn.down = true;
      const logged: string[] = [];
      const spy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation((m: unknown) => void logged.push(String(m)));
      const res = await list(superToken, {
        perPage: 5,
        q: `${STEM}-ada`,
      }).expect(200);
      spy.mockRestore();
      expect(res.body.contactUnavailable).toBe(true);
      const items = res.body.data as Array<Record<string, unknown>>;
      expect(items.map((i) => i.wawuId)).toEqual([ADA]);
      expect(items[0]).toMatchObject({
        wawuId: ADA,
        handle: `${STEM}-Ada`,
        firstName: null,
        lastName: null,
        email: null,
        phone: null,
        countryCode: 'NG',
        tickHeld: true,
        walletOpened: true,
      });
      expect(logged.join(' ')).not.toContain(`${STEM}-ada`);
      expect(logged.join(' ')).not.toContain(EMAIL_ADA);
    });

    it('pages with page and perPage', async () => {
      const p1 = await list(superToken, { perPage: 2, page: 1 }).expect(200);
      const p2 = await list(superToken, { perPage: 2, page: 2 }).expect(200);
      expect(
        (p1.body.data as Array<{ wawuId: string }>).map((i) => i.wawuId),
      ).toEqual([ADA, BOLA]);
      expect(
        (p2.body.data as Array<{ wawuId: string }>).map((i) => i.wawuId),
      ).toEqual([CHIDI, DELE]);
      expect(p1.body.pagination.nextPage).toBe(2);
    });

    it('rejects q under 2 characters and unknown query fields', async () => {
      await list(superToken, { q: 'a' }).expect(400);
      await list(superToken, { nope: '1' }).expect(400);
    });

    describe('with q', () => {
      it('matches part of a handle in the Hub, case-insensitively', async () => {
        const res = await list(superToken, { q: `${STEM}-DELE` }).expect(200);
        expect(
          (res.body.data as Array<{ wawuId: string }>).map((i) => i.wawuId),
        ).toEqual([DELE]);
        expect(res.body.pagination.total).toBe(1);
      });

      it('matches a part of a name through WAWU ID, keeping only people with a Hub account', async () => {
        // "Ada" is Ada Eze (Hub account), Bola Adaobi (part of "Adaobi") and Ada Ghost (no Hub account).
        const res = await list(superToken, { q: 'ada', perPage: 10 }).expect(
          200,
        );
        const ids = (res.body.data as Array<{ wawuId: string }>).map(
          (i) => i.wawuId,
        );
        expect(ids).toEqual(expect.arrayContaining([ADA, BOLA]));
        expect(ids).not.toContain(GHOST);
        expect(standIn.searchCalls[0].q).toBe('ada');
        // contact fields still come from the one call by ids for the page
        expect(standIn.idCalls).toHaveLength(1);
      });

      it('matches a whole email', async () => {
        const res = await list(superToken, { q: EMAIL_ADA }).expect(200);
        expect(
          (res.body.data as Array<{ wawuId: string }>).map((i) => i.wawuId),
        ).toEqual([ADA]);
        const none = await list(superToken, { q: 'ada.ctrct' }).expect(200);
        expect(
          (none.body.data as Array<{ wawuId: string }>).map((i) => i.wawuId),
        ).not.toContain(ADA);
      });

      it('passes a phone written 080... to WAWU ID as written and finds the person', async () => {
        const res = await list(superToken, { q: '08031230001' }).expect(200);
        expect(standIn.searchCalls[0].q).toBe('08031230001');
        expect(
          (res.body.data as Array<{ wawuId: string }>).map((i) => i.wawuId),
        ).toEqual([ADA]);
        const plus = await list(superToken, { q: '+234 803 123 0001' }).expect(
          200,
        );
        expect(
          (plus.body.data as Array<{ wawuId: string }>).map((i) => i.wawuId),
        ).toEqual([ADA]);
      });

      it('lists a person who is only in WAWU ID as nobody', async () => {
        const res = await list(superToken, { q: EMAIL_GHOST }).expect(200);
        expect(res.body.data).toEqual([]);
        expect(res.body.pagination.total).toBe(0);
      });

      it('pages a search over the union of handle and WAWU ID matches', async () => {
        const p1 = await list(superToken, {
          q: 'ada',
          perPage: 1,
          page: 1,
        }).expect(200);
        const p2 = await list(superToken, {
          q: 'ada',
          perPage: 1,
          page: 2,
        }).expect(200);
        expect(p1.body.pagination.total).toBeGreaterThanOrEqual(2);
        expect((p1.body.data as Array<{ wawuId: string }>)[0].wawuId).toBe(ADA);
        expect((p2.body.data as Array<{ wawuId: string }>)[0].wawuId).toBe(
          BOLA,
        );
      });
    });
  });

  describe('GET /admin/users/counts', () => {
    it('answers total, creators, joinedToday and noCountry', async () => {
      const before = (
        await http()
          .get('/api/hub/admin/users/counts')
          .set(auth(superToken))
          .expect(200)
      ).body.data;
      expect(Object.keys(before).sort()).toEqual([
        'creators',
        'joinedToday',
        'noCountry',
        'total',
      ]);
      expect(before.total).toBe(await prisma.userProfile.count());
      expect(before.creators).toBe(
        await prisma.userProfile.count({ where: { accountType: 'creator' } }),
      );

      // One account made now and one made just before the Lagos day began.
      const now = new Date();
      const startOfDay = lagosDayStart(now);
      await prisma.userProfile.createMany({
        data: [
          {
            wawuUserId: 'b2000000-0000-4000-8000-0000000000e1',
            accountType: 'user',
            interests: [],
            createdAt: now,
          },
          {
            wawuUserId: 'b2000000-0000-4000-8000-0000000000e2',
            accountType: 'user',
            interests: [],
            createdAt: new Date(startOfDay.getTime() - 1),
          },
        ],
      });
      try {
        const after = (
          await http()
            .get('/api/hub/admin/users/counts')
            .set(auth(supportToken))
            .expect(200)
        ).body.data;
        expect(after.total).toBe(before.total + 2);
        expect(after.joinedToday).toBe(before.joinedToday + 1);
        expect(after.noCountry).toBe(before.noCountry + 2);
      } finally {
        await prisma.userProfile.deleteMany({
          where: {
            wawuUserId: {
              in: [
                'b2000000-0000-4000-8000-0000000000e1',
                'b2000000-0000-4000-8000-0000000000e2',
              ],
            },
          },
        });
      }
    });

    it('counts a person with no country row or an empty one as no country', async () => {
      const base = (
        await http()
          .get('/api/hub/admin/users/counts')
          .set(auth(superToken))
          .expect(200)
      ).body.data;
      await prisma.profileDetails.create({ data: { wawuUserId: CHIDI } });
      const withEmptyRow = (
        await http()
          .get('/api/hub/admin/users/counts')
          .set(auth(superToken))
          .expect(200)
      ).body.data;
      expect(withEmptyRow.noCountry).toBe(base.noCountry);
      await prisma.profileDetails.update({
        where: { wawuUserId: CHIDI },
        data: { countryCode: 'NG', countrySource: 'profile' },
      });
      const filled = (
        await http()
          .get('/api/hub/admin/users/counts')
          .set(auth(superToken))
          .expect(200)
      ).body.data;
      expect(filled.noCountry).toBe(base.noCountry - 1);
    });
  });

  describe('lagosDayStart', () => {
    it('starts the day at 23:00 UTC the evening before (Lagos is UTC+1)', () => {
      expect(
        lagosDayStart(new Date('2026-11-16T22:30:00Z')).toISOString(),
      ).toBe('2026-11-15T23:00:00.000Z');
      expect(
        lagosDayStart(new Date('2026-11-16T23:30:00Z')).toISOString(),
      ).toBe('2026-11-16T23:00:00.000Z');
      expect(
        lagosDayStart(new Date('2026-11-16T23:00:00Z')).toISOString(),
      ).toBe('2026-11-16T23:00:00.000Z');
    });
  });
});
