/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument */
import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { UserProfileModule } from '../../user-profile/user-profile.module';
import { MeModule } from '../../me/me.module';
import { AdminAuthModule } from '../../admin/auth/admin-auth.module';
import { AdminCreatorsModule } from '../../admin/creators/admin-creators.module';
import { AdminContentReviewModule } from '../../admin/content-review/admin-content-review.module';
import {
  adminFixtures,
  adminJwtSecrets,
  bearer,
  deleteAdminFixtures,
  loginAllAdmins,
  seedAdminFixtures,
  type AdminTokens,
} from '../../common/tests/admin-session.helper';
import { GeoModule } from '../geo.module';
import { ProfileLocationService } from '../profile-location.service';

/**
 * GEO-02 (R-85): the country and region lists, a person's place on their
 * profile, GET /me/location, and the admin filters and counts. Written as
 * what a person (or an operator) can do. Needs the database and the WAWU ID
 * stand-in (mock-wawu-id), like the other contract specs.
 */

const USER_PLAIN = '00000000-0000-4000-8000-000000000001';
const USER_CREATOR_BASIC = '00000000-0000-4000-8000-000000000002';

const MOCK_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_BASE = `http://localhost:${MOCK_PORT}`;

// Suite-owned accounts (the admin lists and counts), swept in afterAll.
const P = 'b25ge000-0000-4000-8000-0000000000';
const ACC_LAGOS_CREATOR = `${P}01`;
const ACC_OGUN_CREATOR = `${P}02`;
const ACC_NG_USER = `${P}03`;
const ACC_GB_CREATOR = `${P}04`;
const ACC_NO_PLACE = `${P}05`;
/** Only GET /me/location's claims test uses this one (it has no handle and is not in the admin lists). */
const ACC_CLAIMS = `${P}06`;
const ACC_IDS = [
  ACC_LAGOS_CREATOR,
  ACC_OGUN_CREATOR,
  ACC_NG_USER,
  ACC_GB_CREATOR,
  ACC_NO_PLACE,
];
const STEM = 'geo02ctr';
const CLEAN_IDS = [...ACC_IDS, ACC_CLAIMS];
const PIECE_NG = `${P}a1`;
const PIECE_GB = `${P}a2`;
const PIECE_IDS = [PIECE_NG, PIECE_GB];

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
  const res = await fetch(`${MOCK_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) throw new Error(`mock-wawu-id login failed: ${res.status}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

describe('Countries, regions and a person’s place (GEO-02, contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let places: ProfileLocationService;
  let mockWawuId: ChildProcess | undefined;
  let ownedMock = false;
  let userToken: string;
  let creatorToken: string;
  let admins: AdminTokens;
  const adminSet = adminFixtures('b25ge001', 'geo02');
  const envSnapshot: Record<string, string | undefined> = {};
  let baseline: Awaited<ReturnType<typeof counts>>;

  const http = () => request(app.getHttpServer());
  const asUser = (token: string) => ({ Authorization: `Bearer ${token}` });
  const patch = (token: string, body: Record<string, unknown>) =>
    http()
      .patch('/api/hub/users/me/profile-fields')
      .set(asUser(token))
      .send(body);
  const reasonOf = (res: request.Response) =>
    (res.body as { reason?: { code?: string } }).reason?.code;

  async function counts(query = '') {
    const res = await http()
      .get(`/api/hub/admin/geo/counts${query}`)
      .set(bearer(admins.superadmin))
      .expect(200);
    return res.body.data as {
      people: number;
      creators: number;
      unknown: { people: number; creators: number };
      countries: Array<{
        countryCode: string;
        countryName: string;
        people: number;
        creators: number;
        regions: Array<{
          regionCode: string | null;
          regionName: string | null;
          people: number;
          creators: number;
        }>;
      }>;
    };
  }

  const line = (data: Awaited<ReturnType<typeof counts>>, code: string) =>
    data.countries.find((c) => c.countryCode === code);

  async function clearSuiteRows() {
    await prisma.contentPiece.deleteMany({ where: { id: { in: PIECE_IDS } } });
    await prisma.profileDetails.deleteMany({
      where: {
        wawuUserId: { in: [...CLEAN_IDS, USER_PLAIN, USER_CREATOR_BASIC] },
      },
    });
    await prisma.userProfile.deleteMany({
      where: { wawuUserId: { in: CLEAN_IDS } },
    });
  }

  beforeAll(async () => {
    for (const key of ['ADMIN_JWT_SECRET', 'ADMIN_JWT_REFRESH_SECRET']) {
      envSnapshot[key] = process.env[key];
    }
    const secrets = adminJwtSecrets('geo02');
    process.env.ADMIN_JWT_SECRET = secrets.access;
    process.env.ADMIN_JWT_REFRESH_SECRET = secrets.refresh;

    if (!(await waitForHealth(`${MOCK_BASE}/health`, 1000))) {
      mockWawuId = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '../../../mock-wawu-id'),
        env: { ...process.env, MOCK_WAWU_ID_PORT: MOCK_PORT },
        stdio: 'ignore',
      });
      ownedMock = true;
      if (!(await waitForHealth(`${MOCK_BASE}/health`))) {
        throw new Error('mock-wawu-id did not become healthy in time');
      }
    }
    userToken = await login('user@test.wawu.dev');
    creatorToken = await login('creator-basic@test.wawu.dev');

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        GeoModule,
        UserProfileModule,
        MeModule,
        AdminAuthModule,
        AdminCreatorsModule,
        AdminContentReviewModule,
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
    prisma = moduleRef.get(PrismaService);
    places = moduleRef.get(ProfileLocationService);
    await clearSuiteRows();
    await seedAdminFixtures(prisma, adminSet);
    admins = await loginAllAdmins(app, adminSet);
    baseline = await counts();
  }, 60000);

  afterAll(async () => {
    if (prisma) {
      await clearSuiteRows();
      await deleteAdminFixtures(prisma, adminSet);
    }
    await app?.close();
    if (ownedMock && mockWawuId) mockWawuId.kill();
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(async () => {
    await prisma.profileDetails.deleteMany({
      where: { wawuUserId: { in: [USER_PLAIN, USER_CREATOR_BASIC] } },
    });
  });

  // ── the lists ───────────────────────────────────────────────────────────

  describe('GET /geo/countries and /geo/countries/{code}/regions', () => {
    it('anyone can read the country list, with no token, and it is cacheable', async () => {
      const res = await http().get('/api/hub/geo/countries').expect(200);
      expect(res.headers['cache-control']).toBe('public, max-age=86400');
      expect(res.headers.etag).toBeTruthy();
      const items = res.body.data.items as Array<Record<string, unknown>>;
      expect(items).toHaveLength(249);
      expect(items.find((c) => c.code === 'NG')).toMatchObject({
        name: 'Nigeria',
        dialCode: '+234',
        flag: '🇳🇬',
        hasRegions: true,
      });
      // Every key is always there.
      for (const c of items) {
        expect(Object.keys(c).sort()).toEqual(
          [
            'code',
            'dialCode',
            'exampleNational',
            'exampleNumber',
            'flag',
            'hasRegions',
            'name',
          ].sort(),
        );
      }
    });

    it('an unchanged list answers 304 to the browser’s own validator', async () => {
      const first = await http().get('/api/hub/geo/countries').expect(200);
      await http()
        .get('/api/hub/geo/countries')
        .set('If-None-Match', first.headers.etag)
        .expect(304);
    });

    it('anyone can read a country’s regions, in any case of the code', async () => {
      for (const code of ['NG', 'ng']) {
        const res = await http()
          .get(`/api/hub/geo/countries/${code}/regions`)
          .expect(200);
        expect(res.headers['cache-control']).toBe('public, max-age=86400');
        expect(res.body.data.countryCode).toBe('NG');
        expect(res.body.data.items).toHaveLength(37);
        expect(res.body.data.items[0]).toEqual({
          code: expect.stringMatching(/^NG-/),
          name: expect.any(String),
          type: expect.any(String),
        });
      }
    });

    it('answers 200 with nothing for a country ISO divides into nothing, and 404 for an unknown code', async () => {
      const aq = await http()
        .get('/api/hub/geo/countries/AQ/regions')
        .expect(200);
      expect(aq.body.data).toEqual({ countryCode: 'AQ', items: [] });
      const bad = await http()
        .get('/api/hub/geo/countries/ZZ/regions')
        .expect(404);
      expect(reasonOf(bad)).toBe('country_not_found');
      await http().get('/api/hub/geo/countries/NIGERIA/regions').expect(404);
    });
  });

  // ── the profile ─────────────────────────────────────────────────────────

  describe('PATCH /users/me/profile-fields takes a country, region and city', () => {
    it('saves them checked against the lists, and returns them with the names', async () => {
      const res = await patch(userToken, {
        countryCode: 'ng',
        regionCode: 'NG-LA',
        city: '  Ikeja ',
      }).expect(200);
      expect(res.body.data).toMatchObject({
        countryCode: 'NG',
        countryName: 'Nigeria',
        regionCode: 'NG-LA',
        regionName: 'Lagos',
        city: 'Ikeja',
      });
      const mine = await http()
        .get('/api/hub/users/me/profile-fields')
        .set(asUser(userToken))
        .expect(200);
      expect(mine.body.data).toMatchObject({
        countryCode: 'NG',
        regionCode: 'NG-LA',
        regionName: 'Lagos',
        city: 'Ikeja',
      });
      const row = await prisma.profileDetails.findUnique({
        where: { wawuUserId: USER_PLAIN },
      });
      expect(row).toMatchObject({
        countryCode: 'NG',
        regionCode: 'NG-LA',
        regionName: 'Lagos',
        city: 'Ikeja',
        countrySource: 'profile',
      });
    });

    it('keeps the old free-text location working beside them, each on its own', async () => {
      await patch(userToken, { location: 'Lagos, Nigeria' }).expect(200);
      const res = await patch(userToken, {
        countryCode: 'GH',
        city: 'Accra',
      }).expect(200);
      expect(res.body.data).toMatchObject({
        location: 'Lagos, Nigeria',
        countryCode: 'GH',
        city: 'Accra',
      });
      const cleared = await patch(userToken, { location: '' }).expect(200);
      expect(cleared.body.data).toMatchObject({
        location: null,
        countryCode: 'GH',
      });
    });

    it('takes a region by name when the country is saved, and clears it with the country', async () => {
      await patch(userToken, { countryCode: 'NG' }).expect(200);
      const byName = await patch(userToken, { regionName: 'Ogun' }).expect(200);
      expect(byName.body.data).toMatchObject({
        regionCode: 'NG-OG',
        regionName: 'Ogun',
      });
      const moved = await patch(userToken, { countryCode: 'GH' }).expect(200);
      expect(moved.body.data).toMatchObject({
        countryCode: 'GH',
        regionCode: null,
        regionName: null,
      });
      const gone = await patch(userToken, {
        countryCode: null,
        city: null,
      }).expect(200);
      expect(gone.body.data).toMatchObject({
        countryCode: null,
        countryName: null,
        city: null,
      });
    });

    it('refuses what is not on the lists, with a stable reason, and saves none of the request', async () => {
      const country = await patch(userToken, {
        skills: ['Directing'],
        countryCode: 'ZZ',
      }).expect(400);
      expect(reasonOf(country)).toBe('country_invalid');
      const region = await patch(userToken, {
        countryCode: 'NG',
        regionCode: 'GH-AA',
      }).expect(400);
      expect(reasonOf(region)).toBe('region_invalid');
      const orphan = await patch(userToken, { regionCode: 'NG-LA' }).expect(
        400,
      );
      expect(reasonOf(orphan)).toBe('region_needs_country');
      const long = await patch(userToken, { city: 'x'.repeat(81) }).expect(400);
      expect(reasonOf(long)).toBe('city_too_long');
      const mine = await http()
        .get('/api/hub/users/me/profile-fields')
        .set(asUser(userToken))
        .expect(200);
      expect(mine.body.data.skills).toEqual([]);
      expect(mine.body.data.countryCode).toBeNull();
    });

    it('does not widen what the web reads: GET and PATCH /users/me carry none of the new keys', async () => {
      await patch(userToken, { countryCode: 'NG', city: 'Ikeja' }).expect(200);
      const got = await http().get('/api/hub/users/me').set(asUser(userToken));
      expect(got.status).toBe(200);
      const body = JSON.stringify(got.body);
      for (const key of [
        'countryCode',
        'regionCode',
        'regionName',
        '"city"',
        'countrySource',
      ]) {
        expect(body).not.toContain(key);
      }
    });

    it('shows a visitor a country only when the person chose it', async () => {
      await patch(creatorToken, {
        countryCode: 'GB',
        regionCode: 'GB-ENG',
      }).expect(200);
      const seen = await http()
        .get(`/api/hub/users/${USER_CREATOR_BASIC}/profile-fields`)
        .set(asUser(userToken))
        .expect(200);
      expect(seen.body.data).toMatchObject({
        countryCode: 'GB',
        countryName: 'United Kingdom',
        regionCode: 'GB-ENG',
      });

      // The same country, but worked out from the phone: theirs to see, not a visitor's.
      await prisma.profileDetails.update({
        where: { wawuUserId: USER_CREATOR_BASIC },
        data: { countrySource: 'phone', regionCode: null, regionName: null },
      });
      const hidden = await http()
        .get(`/api/hub/users/${USER_CREATOR_BASIC}/profile-fields`)
        .set(asUser(userToken))
        .expect(200);
      expect(hidden.body.data).toMatchObject({
        countryCode: null,
        countryName: null,
      });
      const own = await http()
        .get('/api/hub/users/me/profile-fields')
        .set(asUser(creatorToken))
        .expect(200);
      expect(own.body.data.countryCode).toBe('GB');
    });
  });

  // ── /me/location ────────────────────────────────────────────────────────

  describe('GET /me/location', () => {
    it('needs a sign-in', async () => {
      await http().get('/api/hub/me/location').expect(401);
    });

    it('shows the country WAWU ID holds, records it, and keeps what the person chooses after', async () => {
      const first = await http()
        .get('/api/hub/me/location')
        .set(asUser(userToken))
        .expect(200);
      expect(first.body.data).toEqual({
        countryCode: 'NG',
        countryName: 'Nigeria',
        countrySource: 'wawu_id',
        regionCode: null,
        regionName: null,
        city: null,
        wawuIdCountryCode: 'NG',
        phoneCountryCode: 'NG',
      });
      expect(
        (
          await prisma.profileDetails.findUnique({
            where: { wawuUserId: USER_PLAIN },
          })
        )?.countrySource,
      ).toBe('wawu_id');

      await patch(userToken, { countryCode: 'GH', city: 'Accra' }).expect(200);
      const chosen = await http()
        .get('/api/hub/me/location')
        .set(asUser(userToken))
        .expect(200);
      expect(chosen.body.data).toMatchObject({
        countryCode: 'GH',
        countrySource: 'profile',
        city: 'Accra',
        wawuIdCountryCode: 'NG',
      });
    });

    it('reads the ISO claim first, then the older text, then the phone', async () => {
      const id = ACC_CLAIMS;
      await prisma.userProfile.upsert({
        where: { wawuUserId: id },
        update: {},
        create: { wawuUserId: id, accountType: 'user', interests: [] },
      });
      const me = (claims: Record<string, unknown>) => places.me(id, claims);

      expect(await me({ countryCode: 'gh', country: 'Nigeria' })).toMatchObject(
        {
          countryCode: 'GH',
          countrySource: 'wawu_id',
        },
      );
      expect(
        await me({ countryCode: null, country: 'United Kingdom' }),
      ).toMatchObject({
        countryCode: 'GB',
        countrySource: 'wawu_id',
      });
      expect(
        await me({ country: 'Narnia', phone: '+233241234567' }),
      ).toMatchObject({
        countryCode: 'GH',
        countrySource: 'phone',
        wawuIdCountryCode: null,
        phoneCountryCode: 'GH',
      });
      expect(await me({})).toMatchObject({
        countryCode: 'GH',
        countrySource: 'phone',
      });

      // A region saved under one country goes when WAWU ID moves the person to another.
      await prisma.profileDetails.update({
        where: { wawuUserId: id },
        data: {
          countryCode: 'NG',
          countrySource: 'wawu_id',
          regionCode: 'NG-LA',
          regionName: 'Lagos',
        },
      });
      expect(await me({ countryCode: 'NG' })).toMatchObject({
        countryCode: 'NG',
        regionCode: 'NG-LA',
      });
      expect(await me({ countryCode: 'GH' })).toMatchObject({
        countryCode: 'GH',
        regionCode: null,
        regionName: null,
      });
      // A country the person chose is never replaced.
      await prisma.profileDetails.update({
        where: { wawuUserId: id },
        data: { countrySource: 'profile' },
      });
      expect(await me({ countryCode: 'NG' })).toMatchObject({
        countryCode: 'GH',
        countrySource: 'profile',
      });
      // Not one of the admin fixtures: leave no account behind to be counted.
      await prisma.profileDetails.deleteMany({ where: { wawuUserId: id } });
      await prisma.userProfile.deleteMany({ where: { wawuUserId: id } });
    });
  });

  // ── the dashboard ───────────────────────────────────────────────────────

  describe('admin: filters and counts by country and region', () => {
    const search = (query: Record<string, unknown>, token = admins.support) =>
      http()
        .get('/api/hub/admin/creators')
        .query({ perPage: 100, q: STEM, ...query })
        .set(bearer(token));
    const ids = (res: request.Response) =>
      (res.body.data as Array<{ wawuUserId: string }>)
        .map((r) => r.wawuUserId)
        .sort();

    beforeAll(async () => {
      await prisma.userProfile.createMany({
        data: [
          {
            wawuUserId: ACC_LAGOS_CREATOR,
            accountType: 'creator',
            handle: `${STEM}-lagos`,
            interests: [],
          },
          {
            wawuUserId: ACC_OGUN_CREATOR,
            accountType: 'creator',
            handle: `${STEM}-ogun`,
            interests: [],
          },
          {
            wawuUserId: ACC_NG_USER,
            accountType: 'user',
            handle: `${STEM}-ngu`,
            interests: [],
          },
          {
            wawuUserId: ACC_GB_CREATOR,
            accountType: 'creator',
            handle: `${STEM}-gb`,
            interests: [],
          },
          {
            wawuUserId: ACC_NO_PLACE,
            accountType: 'user',
            handle: `${STEM}-none`,
            interests: [],
          },
        ],
        skipDuplicates: true,
      });
      await prisma.profileDetails.deleteMany({
        where: { wawuUserId: ACC_NO_PLACE },
      });
      await prisma.profileDetails.createMany({
        data: [
          {
            wawuUserId: ACC_LAGOS_CREATOR,
            countryCode: 'NG',
            regionCode: 'NG-LA',
            regionName: 'Lagos',
            countrySource: 'profile',
          },
          {
            wawuUserId: ACC_OGUN_CREATOR,
            countryCode: 'NG',
            regionCode: 'NG-OG',
            regionName: 'Ogun',
            countrySource: 'profile',
          },
          {
            wawuUserId: ACC_NG_USER,
            countryCode: 'NG',
            countrySource: 'phone',
          },
          {
            wawuUserId: ACC_GB_CREATOR,
            countryCode: 'GB',
            countrySource: 'wawu_id',
          },
        ],
        skipDuplicates: true,
      });
      await prisma.contentPiece.createMany({
        data: [PIECE_NG, PIECE_GB].map((id, i) => ({
          id,
          creatorWawuId: i === 0 ? ACC_LAGOS_CREATOR : ACC_GB_CREATOR,
          slug: `geo02-contract-${i}`,
          title: `GEO-02 fixture ${i}`,
          description: 'Fixture for the GEO-02 contract suite.',
          category: 'geo02-contract',
          tags: [],
          contentType: 'video' as const,
          accessType: 'free' as const,
          price: 0,
          status: 'pending' as const,
          previewAssetUrl: 'content/preview/geo02/fixture.jpg',
        })),
        skipDuplicates: true,
      });
    });

    it('filters the people and creators list by country, and by region', async () => {
      expect(ids(await search({ countryCode: 'ng' }).expect(200))).toEqual(
        [ACC_LAGOS_CREATOR, ACC_NG_USER, ACC_OGUN_CREATOR].sort(),
      );
      expect(
        ids(
          await search({ countryCode: 'NG', regionCode: 'NG-LA' }).expect(200),
        ),
      ).toEqual([ACC_LAGOS_CREATOR]);
      // A region alone carries its country.
      expect(ids(await search({ regionCode: 'ng-og' }).expect(200))).toEqual([
        ACC_OGUN_CREATOR,
      ]);
      expect(
        ids(
          await search({ countryCode: 'NG', accountType: 'creator' }).expect(
            200,
          ),
        ),
      ).toEqual([ACC_LAGOS_CREATOR, ACC_OGUN_CREATOR].sort());
      expect(ids(await search({ countryCode: 'GB' }).expect(200))).toEqual([
        ACC_GB_CREATOR,
      ]);
      // Nobody in a country with nobody.
      expect(ids(await search({ countryCode: 'JP' }).expect(200))).toEqual([]);
      // Without the filter, everyone, including the person with no place yet.
      expect(ids(await search({}).expect(200))).toEqual([...ACC_IDS].sort());
    });

    it('leaves the list rows exactly as they were: the place is the filter, not a new key on each row', async () => {
      const res = await search({}).expect(200);
      for (const row of res.body.data as Array<Record<string, unknown>>) {
        expect(Object.keys(row).sort()).toEqual(
          ['accountType', 'createdAt', 'gates', 'handle', 'wawuUserId'].sort(),
        );
      }
    });

    it('refuses a country or region that is not on the lists, and a region of another country', async () => {
      for (const query of [
        { countryCode: 'ZZ' },
        { regionCode: 'NG-ZZ' },
        { countryCode: 'GH', regionCode: 'NG-LA' },
      ]) {
        const res = await search(query).expect(400);
        expect(['country_invalid', 'region_invalid']).toContain(reasonOf(res));
      }
    });

    it('filters the content queue by where the creator lives', async () => {
      const queue = (query: Record<string, unknown>) =>
        http()
          .get('/api/hub/admin/content/queue')
          .query({ perPage: 100, ...query })
          .set(bearer(admins.reviewer))
          .expect(200);
      const ours = (res: request.Response) =>
        (res.body.data as Array<{ id: string }>)
          .map((r) => r.id)
          .filter((id) => PIECE_IDS.includes(id))
          .sort();
      expect(ours(await queue({ countryCode: 'GB' }))).toEqual([PIECE_GB]);
      expect(
        ours(await queue({ countryCode: 'NG', regionCode: 'NG-LA' })),
      ).toEqual([PIECE_NG]);
      expect(ours(await queue({}))).toEqual([PIECE_GB, PIECE_NG].sort());
      await http()
        .get('/api/hub/admin/content/queue')
        .query({ countryCode: 'ZZ' })
        .set(bearer(admins.reviewer))
        .expect(400);
    });

    it('counts accounts by country and region, with creators, and adds up', async () => {
      const now = await counts();
      const was = (code: string) => line(baseline, code);
      const ng = line(now, 'NG')!;
      const gb = line(now, 'GB')!;
      expect(ng.countryName).toBe('Nigeria');
      expect(ng.people - (was('NG')?.people ?? 0)).toBe(3);
      expect(ng.creators - (was('NG')?.creators ?? 0)).toBe(2);
      expect(gb.people - (was('GB')?.people ?? 0)).toBe(1);

      const region = (code: string | null) =>
        ng.regions.find((r) => r.regionCode === code);
      const base = (code: string | null) =>
        was('NG')?.regions.find((r) => r.regionCode === code);
      expect(region('NG-LA')).toMatchObject({ regionName: 'Lagos' });
      expect(region('NG-LA')!.people - (base('NG-LA')?.people ?? 0)).toBe(1);
      expect(region('NG-OG')!.people - (base('NG-OG')?.people ?? 0)).toBe(1);
      // The person in Nigeria with no region has a line of their own.
      expect(region(null)!.people - (base(null)?.people ?? 0)).toBe(1);

      expect(now.people - baseline.people).toBe(5);
      expect(now.unknown.people - baseline.unknown.people).toBe(1);
      for (const data of [baseline, now]) {
        expect(
          data.countries.reduce((n, c) => n + c.people, 0) +
            data.unknown.people,
        ).toBe(data.people);
        for (const c of data.countries) {
          expect(c.regions.reduce((n, r) => n + r.people, 0)).toBe(c.people);
          const sorted = [...c.regions].sort((a, b) => b.people - a.people);
          expect(c.regions.map((r) => r.people)).toEqual(
            sorted.map((r) => r.people),
          );
        }
      }
    });

    it('narrows the counts to one country, and refuses an unknown one', async () => {
      const one = await counts('?countryCode=ng');
      expect(one.countries.map((c) => c.countryCode)).toEqual(['NG']);
      expect(one.people).toBeGreaterThanOrEqual(5);
      await http()
        .get('/api/hub/admin/geo/counts?countryCode=ZZ')
        .set(bearer(admins.superadmin))
        .expect(400);
    });

    it('lets superadmin, support and finance read the counts, and nobody else', async () => {
      for (const role of ['superadmin', 'support', 'finance'] as const) {
        await http()
          .get('/api/hub/admin/geo/counts')
          .set(bearer(admins[role]))
          .expect(200);
      }
      await http()
        .get('/api/hub/admin/geo/counts')
        .set(bearer(admins.reviewer))
        .expect(403);
      await http().get('/api/hub/admin/geo/counts').expect(401);
      await http()
        .get('/api/hub/admin/geo/counts')
        .set(asUser(userToken))
        .expect(401);
      await search({}, admins.reviewer).expect(403);
    });

    it('shows no name, handle, phone or id in the counts', async () => {
      const text = JSON.stringify(await counts());
      expect(text).not.toContain(STEM);
      expect(text).not.toContain('wawuUserId');
      expect(text).not.toContain('handle');
    });
  });
});
