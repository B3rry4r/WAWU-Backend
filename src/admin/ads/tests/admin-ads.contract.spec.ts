/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return --
   supertest hands back untyped JSON; every field read here is asserted by value. */
import { readFileSync } from 'fs';
import { join } from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import * as jwt from 'jsonwebtoken';
import request from 'supertest';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../../common/auth/wawu-auth.module';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { EventModule } from '../../../event/event.module';
import { AdminAuthModule } from '../../auth/admin-auth.module';
import {
  ADMIN_ACCESS_AUDIENCE,
  ADMIN_REFRESH_AUDIENCE,
  ADMIN_TOKEN_ISSUER,
} from '../../auth/admin-token.service';
import { AdminAdsModule } from '../admin-ads.module';
import { AdsModule } from '../../../ads/ads.module';
import { SERVED_STATUSES as SERVING_STATUSES } from '../../../ads/ads-serving';
import { SERVED_STATUSES } from '../ad-campaign-state';
import { AD_WEIGHT_MAX, AD_WEIGHT_MIN } from '../../../ads/ads-limits';
import { AD_TEXT_LIMITS } from '../../../ads/ads-text-limits';

/**
 * Contract tests for the admin ads routes (task ADS-06, R-15), over HTTP with
 * the real admin guards, on the seeded database.
 *
 * The capability check ("an admin can pause a live campaign and it stops
 * showing within a minute") is the first describe block that touches state. It
 * is proved on the stored state serving filters on: ADS-04 reads status,
 * window, creative and the event on every request and caches nothing, so a
 * pause that has changed the stored status before its response is sent is in
 * force from the next request. The test runs the same filter ADS-04 uses
 * (written out here, not imported: ADS-04 is not part of this branch) before
 * and after, and measures the time from the pause request to the filter
 * returning nothing.
 *
 * Fixtures are suite-owned (`a6` / `e6` id prefixes and the TAG below) and
 * swept in afterAll; afterAll then asserts every table's row count equals what
 * it was at the start.
 */

const MOCK_WAWU_ID_URL =
  process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';
const USER_EMAIL = 'user@test.wawu.dev';

const TAG = 'ADS06-contract';
const PASSWORD = 'admin-ads-contract-password';
const ACCESS_SECRET = 'admin-ads-access-secret-0123456789abcdef';
const REFRESH_SECRET = 'admin-ads-refresh-secret-0123456789abcdef';

const ADMIN = {
  super: 'a6000000-0000-4000-8000-000000000001',
  reviewer: 'a6000000-0000-4000-8000-000000000002',
  support: 'a6000000-0000-4000-8000-000000000003',
  finance: 'a6000000-0000-4000-8000-000000000004',
  suspended: 'a6000000-0000-4000-8000-000000000005',
} as const;
const ADMIN_IDS = Object.values(ADMIN);
const ROLE = {
  super: 'superadmin',
  reviewer: 'reviewer',
  support: 'support',
  finance: 'finance',
  suspended: 'reviewer',
} as const;
const EMAIL = (k: keyof typeof ADMIN) => `ads06-${k}@admin.test.wawu.dev`;

const EV = {
  open: 'e6000000-0000-4000-8000-000000000001',
  open2: 'e6000000-0000-4000-8000-000000000002',
  pending: 'e6000000-0000-4000-8000-000000000003',
  cancelled: 'e6000000-0000-4000-8000-000000000004',
  past: 'e6000000-0000-4000-8000-000000000005',
  removed: 'e6000000-0000-4000-8000-000000000006',
  openNoEnd: 'e6000000-0000-4000-8000-000000000007',
} as const;
const EVENT_IDS = Object.values(EV);
const MISSING_EVENT = 'e6000000-0000-4000-8000-0000000000ff';
const MISSING_CAMPAIGN = 'c6000000-0000-4000-8000-0000000000ff';

const HOUR = 3_600_000;
const iso = (d: Date) => d.toISOString();
const hoursFromNow = (h: number) => new Date(Date.now() + h * HOUR);

const CAMPAIGN_KEYS = [
  'advertiser',
  'createdAt',
  'creative',
  'endsAt',
  'event',
  'id',
  'phase',
  'placement',
  'servingNow',
  'startsAt',
  'status',
  'updatedAt',
  'weight',
];
const DETAIL_KEYS = [...CAMPAIGN_KEYS, 'history', 'overlapping'].sort();
const CREATIVE_KEYS = [
  'artworkUrl',
  'ctaDestination',
  'ctaDestinationId',
  'ctaLabel',
  'headline',
  'subline',
];
const EVENT_KEYS = ['endsAt', 'id', 'name', 'open', 'startsAt', 'status'];
const AUDIT_KEYS = [
  'action',
  'adminEmail',
  'adminId',
  'adminRole',
  'changes',
  'createdAt',
  'id',
  'newStatus',
  'previousStatus',
];
const OVERLAP_KEYS = [
  'advertiser',
  'endsAt',
  'id',
  'startsAt',
  'status',
  'weight',
];
const FIELD_KEYS = [
  'advertiser',
  'artworkUrl',
  'ctaDestination',
  'ctaDestinationId',
  'ctaLabel',
  'endsAt',
  'headline',
  'placement',
  'startsAt',
  'subline',
  'weight',
];

type Json = Record<string, any>;

describe('Admin ads contract (ADS-06)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let userToken: string;
  const tokens = {} as Record<keyof typeof ADMIN, string>;
  const envSnapshot: Record<string, string | undefined> = {};
  let countsBefore: Record<string, number>;

  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const asSuper = () => bearer(tokens.super);
  const BASE = '/api/hub/admin/ads';

  async function tableCounts(): Promise<Record<string, number>> {
    const tables = await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`;
    const out: Record<string, number> = {};
    for (const { tablename } of tables) {
      const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM "${tablename}"`,
      );
      out[tablename] = Number(rows[0].n);
    }
    return out;
  }

  async function sweep(): Promise<void> {
    await prisma.adminAdAudit.deleteMany({
      where: { adminId: { in: ADMIN_IDS } },
    });
    await prisma.adCampaign.deleteMany({
      where: { advertiser: { startsWith: TAG } },
    });
    await prisma.event.deleteMany({ where: { id: { in: EVENT_IDS } } });
  }

  async function resetEvents(): Promise<void> {
    await prisma.event.deleteMany({ where: { id: { in: EVENT_IDS } } });
    const base = {
      hostWawuId: 'a6a6a6a6-0000-4000-8000-000000000001',
      description: 'A fixture event for the admin ads contract suite.',
      hostOrg: 'Contract Fixtures Ltd',
      format: 'in_person' as const,
      type: 'workshop' as const,
      location: 'Abuja',
    };
    const future = hoursFromNow(24 * 60);
    await prisma.event.createMany({
      data: [
        {
          ...base,
          id: EV.open,
          name: 'Gospel Night Live',
          status: 'published',
          startsAt: future,
          endsAt: new Date(future.getTime() + 4 * HOUR),
        },
        {
          ...base,
          id: EV.open2,
          name: 'Second open event',
          status: 'published',
          startsAt: future,
          endsAt: new Date(future.getTime() + 4 * HOUR),
        },
        {
          ...base,
          id: EV.openNoEnd,
          name: 'No end event',
          status: 'published',
          startsAt: future,
        },
        {
          ...base,
          id: EV.pending,
          name: 'Pending event',
          status: 'pending',
          startsAt: future,
        },
        {
          ...base,
          id: EV.cancelled,
          name: 'Cancelled event',
          status: 'published',
          startsAt: future,
          cancelledAt: new Date(),
        },
        {
          ...base,
          id: EV.past,
          name: 'Past event',
          status: 'published',
          startsAt: hoursFromNow(-72),
          endsAt: hoursFromNow(-48),
        },
        {
          ...base,
          id: EV.removed,
          name: 'Removed event',
          status: 'removed',
          startsAt: future,
        },
      ],
    });
  }

  /** What a campaign body needs, valid, with overrides merged in. */
  function body(over: Json = {}, creative: Json = {}): Json {
    return {
      advertiser: `${TAG} Acme`,
      placement: 'tgif_card',
      startsAt: iso(hoursFromNow(24)),
      endsAt: iso(hoursFromNow(48)),
      weight: 5,
      creative: {
        headline: 'Gospel Night Live',
        subline: 'Abuja · Sat 18 October · from ₦5,000',
        ctaLabel: 'Get tickets',
        ctaDestination: 'event',
        ctaDestinationId: EV.open,
        artworkUrl: 'https://cdn.example.com/ads/gospel.png',
        ...creative,
      },
      ...over,
    };
  }

  async function create(over: Json = {}, creative: Json = {}): Promise<Json> {
    const res = await http()
      .post(BASE)
      .set(asSuper())
      .send(body(over, creative));
    expect(res.status).toBe(200);
    return res.body.data.campaign;
  }

  /** A campaign in a given status, put there through the API where it can be. */
  async function inStatus(
    status: 'draft' | 'scheduled' | 'live' | 'paused' | 'ended',
    over: Json = {},
  ): Promise<Json> {
    const startsAt =
      status === 'live' || status === 'paused' || status === 'ended'
        ? iso(hoursFromNow(-1))
        : iso(hoursFromNow(24));
    const c = await create({ startsAt, ...over });
    if (status === 'draft') return c;
    await act(c.id, 'schedule');
    if (status === 'paused') await act(c.id, 'pause');
    if (status === 'ended') await act(c.id, 'end');
    return (await http().get(`${BASE}/${c.id}`).set(asSuper())).body.data;
  }

  const act = (id: string, action: string, token = tokens.super) =>
    http().post(`${BASE}/${id}/${action}`).set(bearer(token));

  const rowOf = (id: string) =>
    prisma.adCampaign.findUnique({
      where: { id },
      include: { creative: true },
    });
  const auditOf = (id: string) =>
    prisma.adminAdAudit.findMany({
      where: { campaignId: id },
      orderBy: { seq: 'asc' },
    });

  /**
   * The rule ADS-04 serves by, written out: placement, status scheduled or
   * live, startsAt <= now < endsAt, a creative, and an open event. Not imported
   * (ADS-04 is on its own branch); `servingNow` in the views is the same rule.
   */
  async function servedFor(placement: 'tgif_card' | 'today_slot') {
    const now = new Date();
    const candidates = await prisma.adCampaign.findMany({
      where: {
        placement,
        status: { in: ['scheduled', 'live'] },
        startsAt: { lte: now },
        endsAt: { gt: now },
        creative: { isNot: null },
      },
      include: { creative: true },
    });
    const open = await prisma.event.findMany({
      where: {
        id: { in: candidates.map((c) => c.creative!.ctaDestinationId) },
        status: 'published',
        cancelledAt: null,
        OR: [
          { endsAt: { gte: now } },
          { endsAt: null, startsAt: { gte: now } },
        ],
      },
      select: { id: true },
    });
    const ids = new Set(open.map((e) => e.id));
    return candidates.filter((c) => ids.has(c.creative!.ctaDestinationId));
  }

  async function adminToken(id: string, role: string, email: string) {
    const res = await http()
      .post('/api/hub/admin/auth/login')
      .send({ email, password: PASSWORD });
    if (res.status !== 200)
      throw new Error(`admin login ${role}: ${res.status}`);
    expect(id).toBeTruthy();
    return res.body.data.accessToken as string;
  }

  beforeAll(async () => {
    for (const key of ['ADMIN_JWT_SECRET', 'ADMIN_JWT_REFRESH_SECRET']) {
      envSnapshot[key] = process.env[key];
    }
    process.env.ADMIN_JWT_SECRET = ACCESS_SECRET;
    process.env.ADMIN_JWT_REFRESH_SECRET = REFRESH_SECRET;

    const login = await fetch(`${MOCK_WAWU_ID_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: USER_EMAIL }),
    });
    if (!login.ok)
      throw new Error(`mock-wawu-id login failed: ${login.status}`);
    userToken = ((await login.json()) as { accessToken: string }).accessToken;

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        AdminAuthModule,
        AdminAdsModule,
        // The real user-facing surface, so "an admin token is refused by user
        // routes" is proved against a route a user really calls.
        WawuAuthModule,
        EventModule,
        // The real serving half (ADS-04), so a pause is proved against what a
        // person's app calls and not against a copy of its filter.
        AdsModule,
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

    await sweep();
    countsBefore = await tableCounts();

    const argon2 = await import('argon2');
    const passwordHash = await argon2.hash(PASSWORD);
    await prisma.adminUser.deleteMany({ where: { id: { in: ADMIN_IDS } } });
    await prisma.adminUser.createMany({
      data: (Object.keys(ADMIN) as Array<keyof typeof ADMIN>).map((k) => ({
        id: ADMIN[k],
        email: EMAIL(k),
        name: `Ads06 ${k}`,
        role: ROLE[k],
        passwordHash,
      })),
    });
    for (const k of ['super', 'reviewer', 'support', 'finance'] as const) {
      tokens[k] = await adminToken(ADMIN[k], k, EMAIL(k));
    }
    tokens.suspended = await adminToken(
      ADMIN.suspended,
      'suspended',
      EMAIL('suspended'),
    );
    await prisma.adminUser.update({
      where: { id: ADMIN.suspended },
      data: { status: 'suspended' },
    });
  }, 60_000);

  beforeEach(async () => {
    await prisma.adminAdAudit.deleteMany({
      where: { adminId: { in: ADMIN_IDS } },
    });
    await prisma.adCampaign.deleteMany({
      where: { advertiser: { startsWith: TAG } },
    });
    await resetEvents();
  });

  afterAll(async () => {
    await sweep();
    await prisma.adminUser.deleteMany({ where: { id: { in: ADMIN_IDS } } });
    const after = await tableCounts();
    await app.close();
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    expect(after).toEqual(countsBefore);
  });

  // ── authorisation ────────────────────────────────────────────────────────

  describe('who can reach these routes', () => {
    const routes: Array<[string, string, Json | undefined]> = [
      ['get', '', undefined],
      ['get', '/report', undefined],
      ['post', '', body()],
      ['get', `/${MISSING_CAMPAIGN}`, undefined],
      ['get', `/${MISSING_CAMPAIGN}/report`, undefined],
      ['patch', `/${MISSING_CAMPAIGN}`, { weight: 3 }],
      ['delete', `/${MISSING_CAMPAIGN}`, undefined],
      ['post', `/${MISSING_CAMPAIGN}/schedule`, undefined],
      ['post', `/${MISSING_CAMPAIGN}/pause`, undefined],
      ['post', `/${MISSING_CAMPAIGN}/resume`, undefined],
      ['post', `/${MISSING_CAMPAIGN}/end`, undefined],
    ];
    const call = (m: string, p: string, b: Json | undefined, h: Json) => {
      const r = (http() as any)[m](BASE + p).set(h);
      return b ? r.send(b) : r;
    };

    it.each(routes)('%s %s: no token is 401', async (m, p, b) => {
      const res = await call(m, p, b, {});
      expect(res.status).toBe(401);
      expect(res.body.data).toBeNull();
    });

    it.each(routes)('%s %s: a user (WAWU ID) token is 401', async (m, p, b) => {
      const res = await call(m, p, b, bearer(userToken));
      expect(res.status).toBe(401);
    });

    it('refuses before it validates: a bad body with no token is still 401', async () => {
      const res = await http().post(BASE).send({ nonsense: true });
      expect(res.status).toBe(401);
    });

    const forged: Array<[string, () => string]> = [
      [
        'an expired access token',
        () =>
          jwt.sign(
            {
              email: EMAIL('super'),
              role: 'superadmin',
              tokenVersion: 0,
              typ: 'admin_access',
            },
            ACCESS_SECRET,
            {
              algorithm: 'HS256',
              subject: ADMIN.super,
              issuer: ADMIN_TOKEN_ISSUER,
              audience: ADMIN_ACCESS_AUDIENCE,
              expiresIn: -60,
            },
          ),
      ],
      [
        'a token for the refresh audience',
        () =>
          jwt.sign(
            {
              email: EMAIL('super'),
              role: 'superadmin',
              tokenVersion: 0,
              typ: 'admin_access',
            },
            ACCESS_SECRET,
            {
              algorithm: 'HS256',
              subject: ADMIN.super,
              issuer: ADMIN_TOKEN_ISSUER,
              audience: ADMIN_REFRESH_AUDIENCE,
              expiresIn: 600,
            },
          ),
      ],
      [
        'a token for another audience',
        () =>
          jwt.sign(
            {
              email: EMAIL('super'),
              role: 'superadmin',
              tokenVersion: 0,
              typ: 'admin_access',
            },
            ACCESS_SECRET,
            {
              algorithm: 'HS256',
              subject: ADMIN.super,
              issuer: ADMIN_TOKEN_ISSUER,
              audience: 'wawu-hub-users',
              expiresIn: 600,
            },
          ),
      ],
      [
        'a token from another issuer',
        () =>
          jwt.sign(
            {
              email: EMAIL('super'),
              role: 'superadmin',
              tokenVersion: 0,
              typ: 'admin_access',
            },
            ACCESS_SECRET,
            {
              algorithm: 'HS256',
              subject: ADMIN.super,
              issuer: 'someone-else',
              audience: ADMIN_ACCESS_AUDIENCE,
              expiresIn: 600,
            },
          ),
      ],
      [
        'a token signed with another secret',
        () =>
          jwt.sign(
            {
              email: EMAIL('super'),
              role: 'superadmin',
              tokenVersion: 0,
              typ: 'admin_access',
            },
            'a-different-secret-0123456789abcdef0123',
            {
              algorithm: 'HS256',
              subject: ADMIN.super,
              issuer: ADMIN_TOKEN_ISSUER,
              audience: ADMIN_ACCESS_AUDIENCE,
              expiresIn: 600,
            },
          ),
      ],
      [
        'a refresh token',
        () =>
          jwt.sign(
            {
              email: EMAIL('super'),
              role: 'superadmin',
              tokenVersion: 0,
              typ: 'admin_refresh',
            },
            REFRESH_SECRET,
            {
              algorithm: 'HS256',
              subject: ADMIN.super,
              issuer: ADMIN_TOKEN_ISSUER,
              audience: ADMIN_REFRESH_AUDIENCE,
              expiresIn: 600,
            },
          ),
      ],
      [
        'an unsigned token',
        () =>
          `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(
            JSON.stringify({
              sub: ADMIN.super,
              iss: ADMIN_TOKEN_ISSUER,
              aud: ADMIN_ACCESS_AUDIENCE,
              typ: 'admin_access',
              role: 'superadmin',
              tokenVersion: 0,
              exp: 4102444800,
            }),
          ).toString('base64url')}.`,
      ],
    ];
    it.each(forged)(
      '%s is 401 on the list and on a write',
      async (_n, make) => {
        const t = make();
        expect((await http().get(BASE).set(bearer(t))).status).toBe(401);
        const before = await prisma.adCampaign.count();
        expect(
          (await http().post(BASE).set(bearer(t)).send(body())).status,
        ).toBe(401);
        expect(await prisma.adCampaign.count()).toBe(before);
      },
    );

    it('a token whose version was bumped is 401, and so is a suspended admin', async () => {
      const bumped = await adminToken(
        ADMIN.finance,
        'finance',
        EMAIL('finance'),
      );
      expect((await http().get(BASE).set(bearer(bumped))).status).toBe(200);
      await prisma.adminUser.update({
        where: { id: ADMIN.finance },
        data: { tokenVersion: { increment: 1 } },
      });
      expect((await http().get(BASE).set(bearer(bumped))).status).toBe(401);
      await prisma.adminUser.update({
        where: { id: ADMIN.finance },
        data: { tokenVersion: { decrement: 1 } },
      });
      expect(
        (await http().get(BASE).set(bearer(tokens.suspended))).status,
      ).toBe(401);
      expect(
        (await http().post(BASE).set(bearer(tokens.suspended)).send(body()))
          .status,
      ).toBe(401);
    });

    it('an admin token is refused by user routes (cross-rejection, other way)', async () => {
      for (const t of [tokens.super, tokens.reviewer]) {
        const res = await http().get('/api/hub/events').set(bearer(t));
        expect(res.status).toBe(401);
      }
      expect(
        (await http().get('/api/hub/events').set(bearer(userToken))).status,
      ).toBe(200);
    });

    it('support and finance can read and cannot write; reviewer and superadmin can do both', async () => {
      const c = await create();
      for (const t of [tokens.support, tokens.finance]) {
        expect((await http().get(BASE).set(bearer(t))).status).toBe(200);
        expect((await http().get(`${BASE}/report`).set(bearer(t))).status).toBe(
          200,
        );
        expect(
          (await http().get(`${BASE}/${c.id}`).set(bearer(t))).status,
        ).toBe(200);
        expect(
          (await http().get(`${BASE}/${c.id}/report`).set(bearer(t))).status,
        ).toBe(200);
        for (const [m, p, b] of [
          ['post', '', body()],
          ['patch', `/${c.id}`, { weight: 9 }],
          ['delete', `/${c.id}`, undefined],
          ['post', `/${c.id}/schedule`, undefined],
          ['post', `/${c.id}/pause`, undefined],
          ['post', `/${c.id}/resume`, undefined],
          ['post', `/${c.id}/end`, undefined],
        ] as Array<[string, string, Json | undefined]>) {
          const res = await call(m, p, b, bearer(t));
          expect([m, p, res.status]).toEqual([m, p, 403]);
        }
      }
      expect((await rowOf(c.id))?.status).toBe('draft');
      expect((await rowOf(c.id))?.weight).toBe(5);
      expect(await auditOf(c.id)).toHaveLength(1);
      const byReviewer = await http()
        .post(`${BASE}/${c.id}/schedule`)
        .set(bearer(tokens.reviewer));
      expect(byReviewer.status).toBe(200);
      expect(byReviewer.body.data.audit.adminRole).toBe('reviewer');
    });
  });

  // ── create ───────────────────────────────────────────────────────────────

  describe('POST /admin/ads', () => {
    it('creates a draft with its card and one audit row, with exactly these keys', async () => {
      const res = await http().post(BASE).set(asSuper()).send(body());
      expect(res.status).toBe(200);
      expect(res.body.statusCode).toBe(200);
      expect(Object.keys(res.body.data).sort()).toEqual(['audit', 'campaign']);
      const c = res.body.data.campaign;
      expect(Object.keys(c).sort()).toEqual(DETAIL_KEYS);
      expect(Object.keys(c.creative).sort()).toEqual(CREATIVE_KEYS);
      expect(Object.keys(c.event).sort()).toEqual(EVENT_KEYS);
      expect(Object.keys(res.body.data.audit).sort()).toEqual(AUDIT_KEYS);
      expect(c).toMatchObject({
        advertiser: `${TAG} Acme`,
        placement: 'tgif_card',
        status: 'draft',
        phase: 'upcoming',
        weight: 5,
        servingNow: false,
        overlapping: [],
        creative: {
          headline: 'Gospel Night Live',
          ctaLabel: 'Get tickets',
          ctaDestination: 'event',
          ctaDestinationId: EV.open,
          artworkUrl: 'https://cdn.example.com/ads/gospel.png',
        },
        event: {
          id: EV.open,
          name: 'Gospel Night Live',
          status: 'published',
          open: true,
        },
      });
      expect(c.history).toHaveLength(1);
      expect(c.history[0]).toEqual(res.body.data.audit);
      expect(res.body.data.audit).toMatchObject({
        action: 'created',
        previousStatus: null,
        newStatus: 'draft',
        adminId: ADMIN.super,
        adminEmail: EMAIL('super'),
        adminRole: 'superadmin',
      });
      expect(Object.keys(res.body.data.audit.changes).sort()).toEqual(
        FIELD_KEYS,
      );
      expect(res.body.data.audit.changes.advertiser).toEqual({
        from: null,
        to: `${TAG} Acme`,
      });
      expect(await auditOf(c.id)).toHaveLength(1);
      const row = await rowOf(c.id);
      expect(row?.status).toBe('draft');
      expect(row?.creative?.headline).toBe('Gospel Night Live');
    });

    it('defaults the weight, accepts no subline and no artwork, and accepts null for both', async () => {
      const a = await create(
        { weight: undefined },
        { subline: undefined, artworkUrl: undefined },
      );
      expect(a.weight).toBe(AD_WEIGHT_MIN);
      expect(a.creative.subline).toBeNull();
      expect(a.creative.artworkUrl).toBeNull();
      const b = await create({}, { subline: null, artworkUrl: null });
      expect(b.creative.subline).toBeNull();
      expect(b.creative.artworkUrl).toBeNull();
    });

    it('stores text trimmed, with one space between words, in NFC', async () => {
      const c = await create(
        { advertiser: `${TAG}  \u00a0 Cafe\u0301   Co  ` },
        {
          headline: '  Gospel\u00a0\u00a0Night  ',
          ctaLabel: '\u3000Get tickets\u3000',
        },
      );
      expect(c.advertiser).toBe(`${TAG} Café Co`);
      expect(c.creative.headline).toBe('Gospel Night');
      expect(c.creative.ctaLabel).toBe('Get tickets');
    });

    it('accepts text exactly at its cap and refuses one more, for every capped field', async () => {
      const at = (n: number) => 'a'.repeat(n);
      const adv = AD_TEXT_LIMITS.advertiser - TAG.length - 1;
      const ok = await http()
        .post(BASE)
        .set(asSuper())
        .send(
          body(
            { advertiser: `${TAG} ${at(adv)}` },
            {
              headline: at(AD_TEXT_LIMITS.headline),
              subline: at(AD_TEXT_LIMITS.subline),
              ctaLabel: at(AD_TEXT_LIMITS.ctaLabel),
            },
          ),
        );
      expect(ok.status).toBe(200);
      const cases: Array<[Json, Json]> = [
        [{ advertiser: `${TAG} ${at(adv + 1)}` }, {}],
        [{}, { headline: at(AD_TEXT_LIMITS.headline + 1) }],
        [{}, { subline: at(AD_TEXT_LIMITS.subline + 1) }],
        [{}, { ctaLabel: at(AD_TEXT_LIMITS.ctaLabel + 1) }],
      ];
      for (const [o, c] of cases) {
        const res = await http().post(BASE).set(asSuper()).send(body(o, c));
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/at most \d+ characters/);
      }
    });

    describe('every input rule is a 400 that writes nothing', () => {
      const U = (...c: number[]) => String.fromCodePoint(...c);
      const invisible = [
        U(0x2800),
        U(0xfffc),
        U(0x3164),
        U(0x200b),
        U(0x00a0),
        U(0xfeff),
        U(0xe0020, 0xe0041),
        U(0x0301),
        U(0x0301, 0x0302),
        U(0x200d),
        U(0x00ad),
        U(0x2063),
        U(0x202e),
        '   ',
        '',
        '\t\n',
      ];
      const fields: Array<[string, (v: unknown) => Json]> = [
        ['advertiser', (v) => body({ advertiser: v })],
        ['headline', (v) => body({}, { headline: v })],
        ['ctaLabel', (v) => body({}, { ctaLabel: v })],
        ['subline', (v) => body({}, { subline: v })],
      ];
      for (const [field, make] of fields) {
        it(`${field}: text with no visible character is refused`, async () => {
          for (const v of invisible) {
            const res = await http().post(BASE).set(asSuper()).send(make(v));
            expect([field, JSON.stringify(v), res.status]).toEqual([
              field,
              JSON.stringify(v),
              400,
            ]);
          }
        });
        it(`${field}: invisible or stray characters inside visible text are refused`, async () => {
          for (const v of [
            `A${U(0x200b)}B`,
            `A${U(0x2800)}B`,
            `A${U(0xe0041)}`,
            `A\nB`,
            `A ${U(0x0301)}B`,
            `A${U(0x202e)}B`,
            `A \u2014 B`,
            `A \u2013 B`,
          ]) {
            const res = await http().post(BASE).set(asSuper()).send(make(v));
            expect([field, JSON.stringify(v), res.status]).toEqual([
              field,
              JSON.stringify(v),
              400,
            ]);
          }
        });
        it(`${field}: a non-string is refused`, async () => {
          for (const v of [5, true, {}, ['x']]) {
            const res = await http().post(BASE).set(asSuper()).send(make(v));
            expect(res.status).toBe(400);
          }
        });
      }

      const bad: Array<[string, Json]> = [
        [
          'no advertiser',
          (() => {
            const b = body();
            delete b.advertiser;
            return b;
          })(),
        ],
        [
          'no placement',
          (() => {
            const b = body();
            delete b.placement;
            return b;
          })(),
        ],
        ['placement outside the list', body({ placement: 'home_banner' })],
        [
          'no startsAt',
          (() => {
            const b = body();
            delete b.startsAt;
            return b;
          })(),
        ],
        [
          'startsAt with an offset',
          body({ startsAt: '2031-01-01T09:00:00+01:00' }),
        ],
        ['startsAt without a zone', body({ startsAt: '2031-01-01T09:00:00' })],
        ['startsAt a bare date', body({ startsAt: '2031-01-01' })],
        ['startsAt not a date', body({ startsAt: 'Saturday' })],
        [
          'startsAt that day does not exist',
          body({ startsAt: '2031-02-31T09:00:00Z' }),
        ],
        ['startsAt a number', body({ startsAt: 1924992000000 })],
        [
          'endsAt equal to startsAt',
          body({
            startsAt: '2031-01-01T09:00:00Z',
            endsAt: '2031-01-01T09:00:00Z',
          }),
        ],
        [
          'endsAt before startsAt',
          body({
            startsAt: '2031-01-02T09:00:00Z',
            endsAt: '2031-01-01T09:00:00Z',
          }),
        ],
        [
          'endsAt already past',
          body({
            startsAt: '2020-01-01T09:00:00Z',
            endsAt: '2020-01-02T09:00:00Z',
          }),
        ],
        ['weight below the range', body({ weight: AD_WEIGHT_MIN - 1 })],
        ['weight above the range', body({ weight: AD_WEIGHT_MAX + 1 })],
        ['weight a fraction', body({ weight: 2.5 })],
        ['weight a string', body({ weight: '5' })],
        ['weight null', body({ weight: null })],
        ['weight huge', body({ weight: 2147483648 })],
        [
          'no creative',
          (() => {
            const b = body();
            delete b.creative;
            return b;
          })(),
        ],
        ['creative empty', body({ creative: {} })],
        ['creative a string', body({ creative: 'card' })],
        ['creative an array', body({ creative: [] })],
        [
          'no headline',
          body({ creative: { ...body().creative, headline: undefined } }),
        ],
        [
          'no ctaLabel',
          body({ creative: { ...body().creative, ctaLabel: undefined } }),
        ],
        [
          'destination outside the allow-list',
          body({}, { ctaDestination: 'creator' }),
        ],
        ['destination an external link', body({}, { ctaDestination: 'url' })],
        ['no destination id', body({}, { ctaDestinationId: undefined })],
        [
          'destination id not an id',
          body({}, { ctaDestinationId: 'gospel-night' }),
        ],
        [
          'destination id an event name',
          body({}, { ctaDestinationId: 'Gospel Night Live' }),
        ],
        ['destination id padded text', body({}, { ctaDestinationId: ' ' })],
        [
          'event that does not exist',
          body({}, { ctaDestinationId: MISSING_EVENT }),
        ],
        ['event still pending', body({}, { ctaDestinationId: EV.pending })],
        ['event removed', body({}, { ctaDestinationId: EV.removed })],
        ['event called off', body({}, { ctaDestinationId: EV.cancelled })],
        ['event already over', body({}, { ctaDestinationId: EV.past })],
        ['artwork javascript', body({}, { artworkUrl: 'javascript:alert(1)' })],
        [
          'artwork data',
          body({}, { artworkUrl: 'data:image/png;base64,AAAA' }),
        ],
        [
          'artwork http',
          body({}, { artworkUrl: 'http://cdn.example.com/a.png' }),
        ],
        [
          'artwork ftp',
          body({}, { artworkUrl: 'ftp://cdn.example.com/a.png' }),
        ],
        [
          'artwork localhost',
          body({}, { artworkUrl: 'https://localhost/a.png' }),
        ],
        [
          'artwork an address',
          body({}, { artworkUrl: 'https://10.0.0.1/a.png' }),
        ],
        [
          'artwork with a password',
          body({}, { artworkUrl: 'https://u:p@cdn.example.com/a.png' }),
        ],
        [
          'artwork with a space',
          body({}, { artworkUrl: 'https://cdn.example.com/a b.png' }),
        ],
        [
          'artwork with markup',
          body({}, { artworkUrl: 'https://cdn.example.com/"><script>' }),
        ],
        ['artwork empty', body({}, { artworkUrl: '' })],
        [
          'artwork too long',
          body(
            {},
            { artworkUrl: `https://cdn.example.com/${'a'.repeat(500)}` },
          ),
        ],
        ['artwork a number', body({}, { artworkUrl: 5 })],
        ['an unknown field', body({ price: 5000 })],
        ['an unknown creative field', body({}, { price: 5000 })],
        ['a status', body({ status: 'live' })],
        ['an id', body({ id: MISSING_CAMPAIGN })],
      ];
      it.each(bad)('%s', async (_n, b) => {
        const before = await prisma.adCampaign.count();
        const audits = await prisma.adminAdAudit.count();
        const res = await http().post(BASE).set(asSuper()).send(b);
        expect(res.status).toBe(400);
        expect(res.body.data).toBeNull();
        expect(typeof res.body.message).toBe('string');
        expect(res.body.message).not.toMatch(/\u2014|\u2013/);
        expect(await prisma.adCampaign.count()).toBe(before);
        expect(await prisma.adminAdAudit.count()).toBe(audits);
      });

      it('an empty body, a non-object body and malformed JSON are 400', async () => {
        for (const send of [{}, [], 'text']) {
          const res = await http()
            .post(BASE)
            .set(asSuper())
            .send(send as never);
          expect(res.status).toBe(400);
        }
        const raw = await http()
          .post(BASE)
          .set(asSuper())
          .set('Content-Type', 'application/json')
          .send('{"advertiser":');
        expect(raw.status).toBe(400);
      });

      it('names the event problem in a reason code, and the field in the message', async () => {
        const res = await http()
          .post(BASE)
          .set(asSuper())
          .send(body({}, { ctaDestinationId: EV.cancelled }));
        expect(res.body.reason).toEqual({ code: 'event_not_open' });
        expect(res.body.message).toMatch(/event/);
      });
    });

    it('lets a campaign start in the past (it starts when scheduled) and end in the future', async () => {
      const c = await create({
        startsAt: iso(hoursFromNow(-5)),
        endsAt: iso(hoursFromNow(5)),
      });
      expect(c.phase).toBe('running');
      expect(c.status).toBe('draft');
      expect(c.servingNow).toBe(false);
    });

    it('accepts an event with no end time while it has not started', async () => {
      const c = await create({}, { ctaDestinationId: EV.openNoEnd });
      expect(c.event.open).toBe(true);
    });

    it('normalises an upper-case event id to the stored spelling', async () => {
      const c = await create({}, { ctaDestinationId: EV.open.toUpperCase() });
      expect(c.creative.ctaDestinationId).toBe(EV.open);
    });

    it('records a second identical create as a second draft (no natural key) with its own audit row', async () => {
      const a = await create();
      const b = await create();
      expect(a.id).not.toBe(b.id);
      expect(await auditOf(a.id)).toHaveLength(1);
      expect(await auditOf(b.id)).toHaveLength(1);
    });
  });

  // ── the capability check ─────────────────────────────────────────────────

  describe('an admin can pause a live campaign and it stops showing within a minute', () => {
    it('is served while live, and not at all from the moment the pause is answered', async () => {
      const c = await inStatus('live', { placement: 'today_slot' });
      expect(c.status).toBe('live');
      expect(c.phase).toBe('running');
      expect(c.servingNow).toBe(true);
      expect((await servedFor('today_slot')).map((x) => x.id)).toContain(c.id);

      const started = Date.now();
      const res = await act(c.id, 'pause');
      expect(res.status).toBe(200);
      // The stored state ADS-04 filters on has changed by the time the
      // response exists, so the next request cannot serve it.
      const stillServed = (await servedFor('today_slot')).map((x) => x.id);
      const elapsed = Date.now() - started;
      expect(stillServed).not.toContain(c.id);
      expect(elapsed).toBeLessThan(60_000);

      expect(res.body.data.campaign.status).toBe('paused');
      expect(res.body.data.campaign.servingNow).toBe(false);
      expect((await rowOf(c.id))?.status).toBe('paused');
      expect(res.body.data.audit).toMatchObject({
        action: 'paused',
        previousStatus: 'live',
        newStatus: 'paused',
      });

      // The summary agrees: nothing is serving on that placement for this campaign.
      const summary = await http().get(`${BASE}/report`).set(asSuper());
      expect(summary.body.data.servingNow.today_slot).toBe(0);
    });

    it('the same holds for a scheduled campaign whose window has opened, and resume puts it back', async () => {
      const c = await create({ startsAt: iso(hoursFromNow(-1)) });
      await act(c.id, 'schedule');
      expect((await servedFor('tgif_card')).map((x) => x.id)).toContain(c.id);
      await act(c.id, 'pause');
      expect((await servedFor('tgif_card')).map((x) => x.id)).not.toContain(
        c.id,
      );
      const resumed = await act(c.id, 'resume');
      expect(resumed.body.data.campaign.status).toBe('live');
      expect((await servedFor('tgif_card')).map((x) => x.id)).toContain(c.id);
      await act(c.id, 'end');
      expect((await servedFor('tgif_card')).map((x) => x.id)).not.toContain(
        c.id,
      );
    });

    it('a campaign scheduled for the future is not served until its window opens, with no timer', async () => {
      const c = await inStatus('scheduled');
      expect(c.status).toBe('scheduled');
      expect(c.phase).toBe('upcoming');
      expect(c.servingNow).toBe(false);
      expect((await servedFor('tgif_card')).map((x) => x.id)).not.toContain(
        c.id,
      );
      // Its window opens: nothing changes in the database, and it is served.
      await prisma.adCampaign.update({
        where: { id: c.id },
        data: { startsAt: hoursFromNow(-1) },
      });
      expect((await servedFor('tgif_card')).map((x) => x.id)).toContain(c.id);
      const detail = await http().get(`${BASE}/${c.id}`).set(asSuper());
      expect(detail.body.data.status).toBe('scheduled');
      expect(detail.body.data.phase).toBe('running');
      expect(detail.body.data.servingNow).toBe(true);
      // And pausing it works exactly as for a live one.
      await act(c.id, 'pause');
      expect((await servedFor('tgif_card')).map((x) => x.id)).not.toContain(
        c.id,
      );
    });

    it('a campaign whose event closes afterwards is left as it is and shows servingNow false', async () => {
      const c = await inStatus('live');
      expect(c.servingNow).toBe(true);
      await prisma.event.update({
        where: { id: EV.open },
        data: { cancelledAt: new Date() },
      });
      const d = (await http().get(`${BASE}/${c.id}`).set(asSuper())).body.data;
      expect(d.status).toBe('live');
      expect(d.event.open).toBe(false);
      expect(d.servingNow).toBe(false);
      expect((await servedFor('tgif_card')).map((x) => x.id)).not.toContain(
        c.id,
      );
      // It cannot be resumed onto a closed event after a pause, either.
      await act(c.id, 'pause');
      const res = await act(c.id, 'resume');
      expect(res.status).toBe(409);
      expect(res.body.reason).toMatchObject({ code: 'event_not_open' });
      expect((await rowOf(c.id))?.status).toBe('paused');
    });
  });

  describe('against the real serving route (ADS-04, GET /ads)', () => {
    const serve = async (placement: string) =>
      (
        await http()
          .get('/api/hub/ads')
          .query({ placement })
          .set(bearer(userToken))
      ).body.data as Json | null;

    it('serves exactly the statuses the admin side puts on air: one list, not two', () => {
      expect(SERVED_STATUSES).toBe(SERVING_STATUSES);
    });

    it('create, schedule, pause: the next GET /ads is null; resume serves it; a closed event stops it', async () => {
      const c = await create({
        startsAt: iso(hoursFromNow(-1)),
        placement: 'today_slot',
      });
      expect(await serve('today_slot')).toBeNull(); // a draft is never served
      expect((await act(c.id, 'schedule')).body.data.campaign.status).toBe(
        'live',
      );
      expect((await serve('today_slot'))?.id).toBe(c.id);

      const started = Date.now();
      expect((await act(c.id, 'pause')).status).toBe(200);
      expect(await serve('today_slot')).toBeNull();
      expect(Date.now() - started).toBeLessThan(60_000);

      expect((await act(c.id, 'resume')).status).toBe(200);
      expect((await serve('today_slot'))?.id).toBe(c.id);

      await prisma.event.update({
        where: { id: EV.open },
        data: { cancelledAt: new Date() },
      });
      expect(await serve('today_slot')).toBeNull();
      const d = (await http().get(`${BASE}/${c.id}`).set(asSuper())).body.data;
      expect([d.status, d.event.open, d.servingNow]).toEqual([
        'live',
        false,
        false,
      ]);
      await prisma.event.update({
        where: { id: EV.open },
        data: { cancelledAt: null },
      });
      expect((await serve('today_slot'))?.id).toBe(c.id);
      expect(
        (await http().get(`${BASE}/${c.id}`).set(asSuper())).body.data
          .servingNow,
      ).toBe(true);

      expect((await act(c.id, 'end')).status).toBe(200);
      expect(await serve('today_slot')).toBeNull();
    });

    it('a scheduled campaign is served once its window opens, and pausing it stops it', async () => {
      const c = await inStatus('scheduled');
      expect(await serve('tgif_card')).toBeNull();
      await prisma.adCampaign.update({
        where: { id: c.id },
        data: { startsAt: hoursFromNow(-1) },
      });
      expect((await serve('tgif_card'))?.id).toBe(c.id);
      await act(c.id, 'pause');
      expect(await serve('tgif_card')).toBeNull();
    });
  });

  // ── the state machine ────────────────────────────────────────────────────

  describe('lifecycle', () => {
    it('draft to scheduled (future start), paused, resumed, ended, with one audit row each', async () => {
      const c = await create();
      const sch = await act(c.id, 'schedule');
      expect(sch.status).toBe(200);
      expect(sch.body.data.campaign.status).toBe('scheduled');
      expect(sch.body.data.audit).toMatchObject({
        action: 'scheduled',
        previousStatus: 'draft',
        newStatus: 'scheduled',
      });
      expect(sch.body.data.audit.changes).toEqual({
        status: { from: 'draft', to: 'scheduled' },
      });

      const pau = await act(c.id, 'pause');
      expect(pau.body.data.campaign.status).toBe('paused');
      const res = await act(c.id, 'resume');
      expect(res.body.data.campaign.status).toBe('scheduled');
      expect(res.body.data.audit).toMatchObject({
        action: 'resumed',
        previousStatus: 'paused',
        newStatus: 'scheduled',
      });
      const end = await act(c.id, 'end');
      expect(end.body.data.campaign.status).toBe('ended');
      expect(end.body.data.audit).toMatchObject({
        action: 'ended',
        previousStatus: 'scheduled',
        newStatus: 'ended',
      });

      const rows = await auditOf(c.id);
      expect(rows.map((r) => r.action)).toEqual([
        'created',
        'scheduled',
        'paused',
        'resumed',
        'ended',
      ]);
      const chain = rows.map((r) => [r.previousStatus, r.newStatus]);
      expect(chain).toEqual([
        [null, 'draft'],
        ['draft', 'scheduled'],
        ['scheduled', 'paused'],
        ['paused', 'scheduled'],
        ['scheduled', 'ended'],
      ]);
      // History in the detail is newest first and is the same five rows.
      const detail = (await http().get(`${BASE}/${c.id}`).set(asSuper())).body
        .data;
      expect(detail.history.map((h: Json) => h.action)).toEqual([
        'ended',
        'resumed',
        'paused',
        'scheduled',
        'created',
      ]);
      expect(detail.history.map((h: Json) => h.id)).toEqual(
        [...rows].reverse().map((r) => r.id),
      );
    });

    it('scheduling a campaign whose window has started stores live, and resume does the same', async () => {
      const c = await create({
        startsAt: iso(hoursFromNow(-2)),
        endsAt: iso(hoursFromNow(2)),
      });
      const sch = await act(c.id, 'schedule');
      expect(sch.body.data.campaign.status).toBe('live');
      expect(sch.body.data.audit.newStatus).toBe('live');
      await act(c.id, 'pause');
      const res = await act(c.id, 'resume');
      expect(res.body.data.campaign.status).toBe('live');
    });

    it('end is allowed from draft, scheduled, live and paused, and ended is final', async () => {
      for (const status of ['draft', 'scheduled', 'live', 'paused'] as const) {
        const c = await inStatus(status);
        const res = await act(c.id, 'end');
        expect([status, res.status]).toEqual([status, 200]);
        expect((await rowOf(c.id))?.status).toBe('ended');
        for (const action of ['schedule', 'pause', 'resume', 'end']) {
          const again = await act(c.id, action);
          expect([status, action, again.status]).toEqual([status, action, 409]);
        }
        const edit = await http()
          .patch(`${BASE}/${c.id}`)
          .set(asSuper())
          .send({ weight: 7 });
        expect(edit.status).toBe(409);
        expect(
          (await http().delete(`${BASE}/${c.id}`).set(asSuper())).status,
        ).toBe(409);
      }
    });

    const allowed: Record<string, string[]> = {
      schedule: ['draft'],
      pause: ['scheduled', 'live'],
      resume: ['paused'],
      end: ['draft', 'scheduled', 'live', 'paused'],
    };
    const statuses = ['draft', 'scheduled', 'live', 'paused', 'ended'] as const;
    const illegal: Array<[string, (typeof statuses)[number]]> = [];
    for (const [action, from] of Object.entries(allowed)) {
      for (const s of statuses)
        if (!from.includes(s)) illegal.push([action, s]);
    }
    it.each(illegal)(
      '%s from %s is a 409 with the allowed statuses, and changes nothing',
      async (action, status) => {
        const c = await inStatus(status);
        const rowBefore = await rowOf(c.id);
        const auditBefore = await prisma.adminAdAudit.count({
          where: { campaignId: c.id },
        });
        const res = await act(c.id, action);
        expect(res.status).toBe(409);
        expect(res.body.statusCode).toBe(409);
        expect(res.body.data).toBeNull();
        expect(res.body.message).toMatch(new RegExp(`This one is ${status}`));
        expect(res.body.message).not.toMatch(/\u2014|\u2013/);
        expect(res.body.reason).toEqual({
          code: 'invalid_transition',
          action,
          status,
          allowedFrom: allowed[action],
        });
        expect(await rowOf(c.id)).toEqual(rowBefore);
        expect(
          await prisma.adminAdAudit.count({ where: { campaignId: c.id } }),
        ).toBe(auditBefore);
      },
    );

    it('repeating an action is a 409, never a quiet 200, and writes no second audit row', async () => {
      const c = await inStatus('live');
      expect((await act(c.id, 'pause')).status).toBe(200);
      expect((await act(c.id, 'pause')).status).toBe(409);
      expect((await act(c.id, 'resume')).status).toBe(200);
      expect((await act(c.id, 'resume')).status).toBe(409);
      expect((await act(c.id, 'end')).status).toBe(200);
      expect((await act(c.id, 'end')).status).toBe(409);
      expect((await auditOf(c.id)).map((r) => r.action)).toEqual([
        'created',
        'scheduled',
        'paused',
        'resumed',
        'ended',
      ]);
    });

    it('an unknown campaign is 404 on every action; a malformed id is 400', async () => {
      for (const action of ['schedule', 'pause', 'resume', 'end']) {
        expect((await act(MISSING_CAMPAIGN, action)).status).toBe(404);
        expect((await act('not-a-uuid', action)).status).toBe(400);
      }
      expect(
        (await http().get(`${BASE}/${MISSING_CAMPAIGN}`).set(asSuper())).status,
      ).toBe(404);
      expect(
        (await http().get(`${BASE}/${MISSING_CAMPAIGN}/report`).set(asSuper()))
          .status,
      ).toBe(404);
      expect(
        (
          await http()
            .patch(`${BASE}/${MISSING_CAMPAIGN}`)
            .set(asSuper())
            .send({ weight: 3 })
        ).status,
      ).toBe(404);
      expect(
        (await http().delete(`${BASE}/${MISSING_CAMPAIGN}`).set(asSuper()))
          .status,
      ).toBe(404);
      expect(
        (await http().get(`${BASE}/not-a-uuid`).set(asSuper())).status,
      ).toBe(400);
      expect(
        await prisma.adminAdAudit.count({
          where: { campaignId: MISSING_CAMPAIGN },
        }),
      ).toBe(0);
    });

    it('will not schedule or resume a campaign whose window is over, or whose event has closed', async () => {
      const over = await create({
        startsAt: iso(hoursFromNow(-3)),
        endsAt: iso(hoursFromNow(3)),
      });
      await prisma.adCampaign.update({
        where: { id: over.id },
        data: { endsAt: hoursFromNow(-1) },
      });
      const s1 = await act(over.id, 'schedule');
      expect(s1.status).toBe(409);
      expect(s1.body.reason).toMatchObject({ code: 'window_over' });
      expect((await rowOf(over.id))?.status).toBe('draft');

      const live = await inStatus('live');
      await act(live.id, 'pause');
      await prisma.adCampaign.update({
        where: { id: live.id },
        data: { endsAt: hoursFromNow(-1) },
      });
      const r1 = await act(live.id, 'resume');
      expect(r1.status).toBe(409);
      expect(r1.body.reason).toMatchObject({ code: 'window_over' });
      expect((await rowOf(live.id))?.status).toBe('paused');
      // It can still be ended.
      expect((await act(live.id, 'end')).status).toBe(200);

      const closed = await create({}, { ctaDestinationId: EV.open2 });
      await prisma.event.update({
        where: { id: EV.open2 },
        data: { status: 'removed' },
      });
      const s2 = await act(closed.id, 'schedule');
      expect(s2.status).toBe(409);
      expect(s2.body.reason).toMatchObject({
        code: 'event_not_open',
        eventId: EV.open2,
      });
      expect((await rowOf(closed.id))?.status).toBe('draft');
      expect(await auditOf(closed.id)).toHaveLength(1);
    });

    it('an event deleted after the booking is a clear 409 on schedule, and event is null in the views', async () => {
      const c = await create({}, { ctaDestinationId: EV.open2 });
      await prisma.event.delete({ where: { id: EV.open2 } });
      const detail = (await http().get(`${BASE}/${c.id}`).set(asSuper())).body
        .data;
      expect(detail.event).toBeNull();
      expect(detail.servingNow).toBe(false);
      const res = await act(c.id, 'schedule');
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/does not exist/);
    });

    it('there is no timer: the module registers no cron or interval', () => {
      const src =
        readFileSync(join(__dirname, '..', 'admin-ads.service.ts'), 'utf8') +
        readFileSync(join(__dirname, '..', 'admin-ads.module.ts'), 'utf8');
      expect(src).not.toMatch(/@Cron|@Interval|setInterval|setTimeout/);
    });
  });

  // ── times outside what the database stores ───────────────────────────────

  describe('a time the database cannot store is a 400 at every place a time is read', () => {
    const bad = [
      '0000-01-01T00:00:00Z',
      '0000-12-31T23:59:59.999Z',
      '-000001-01-01T00:00:00Z',
      '+275760-09-13T00:00:00.000Z',
      '10000-01-01T00:00:00Z',
      '9999-12-31T23:59:60Z',
    ];

    it.each(bad)('create: startsAt and endsAt %s', async (t) => {
      const before = await prisma.adCampaign.count();
      for (const over of [{ startsAt: t }, { endsAt: t }]) {
        const res = await http().post(BASE).set(asSuper()).send(body(over));
        expect(res.status).toBe(400);
        expect(res.body.data).toBeNull();
        expect(res.body.message).toMatch(/UTC time/);
      }
      expect(await prisma.adCampaign.count()).toBe(before);
    });

    it.each(bad)('edit: startsAt and endsAt %s', async (t) => {
      const c = await create();
      for (const send of [{ startsAt: t }, { endsAt: t }]) {
        const res = await http()
          .patch(`${BASE}/${c.id}`)
          .set(asSuper())
          .send(send);
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/UTC time/);
      }
      expect(await auditOf(c.id)).toHaveLength(1);
    });

    it.each(bad)('list and report: from and to %s', async (t) => {
      for (const path of [BASE, `${BASE}/report`]) {
        for (const q of [{ from: t }, { to: t }]) {
          const res = await http().get(path).query(q).set(asSuper());
          expect([path, JSON.stringify(q), res.status]).toEqual([
            path,
            JSON.stringify(q),
            400,
          ]);
          expect(res.body.message).toMatch(/UTC time/);
        }
      }
    });

    it('the first and last stored instants are accepted everywhere and round-trip', async () => {
      const first = '0001-01-01T00:00:00.000Z';
      const last = '9999-12-31T23:59:59.999Z';
      // 0001-01-01 is the first instant Postgres is sent; the window must also end in the future.
      const c = await create({ startsAt: first, endsAt: last });
      expect(c.startsAt).toBe(first);
      expect(c.endsAt).toBe(last);
      const row = await rowOf(c.id);
      expect(row?.startsAt.toISOString()).toBe(first);
      expect(row?.endsAt.toISOString()).toBe(last);
      const d = (await http().get(`${BASE}/${c.id}`).set(asSuper())).body.data;
      expect([d.startsAt, d.endsAt]).toEqual([first, last]);
      const edit = await http()
        .patch(`${BASE}/${c.id}`)
        .set(asSuper())
        .send({ endsAt: '9999-12-31T23:59:59Z' });
      expect(edit.status).toBe(200);
      for (const q of [
        { from: first },
        { to: last },
        { from: first, to: last },
      ]) {
        for (const path of [BASE, `${BASE}/report`]) {
          expect((await http().get(path).query(q).set(asSuper())).status).toBe(
            200,
          );
        }
      }
      expect((await act(c.id, 'schedule')).status).toBe(200);
    });
  });

  // ── edit and delete ──────────────────────────────────────────────────────

  describe('PATCH and DELETE', () => {
    it('edits a draft and a paused campaign and records exactly what changed', async () => {
      const c = await create();
      const res = await http()
        .patch(`${BASE}/${c.id}`)
        .set(asSuper())
        .send({
          advertiser: `${TAG} Renamed`,
          weight: 9,
          creative: {
            headline: '  New   headline ',
            subline: null,
            artworkUrl: null,
          },
        });
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.data).sort()).toEqual(['audit', 'campaign']);
      const d = res.body.data.campaign;
      expect(d).toMatchObject({
        advertiser: `${TAG} Renamed`,
        weight: 9,
        creative: { headline: 'New headline', subline: null, artworkUrl: null },
      });
      expect(res.body.data.audit).toMatchObject({
        action: 'updated',
        previousStatus: 'draft',
        newStatus: 'draft',
      });
      expect(res.body.data.audit.changes).toEqual({
        advertiser: { from: `${TAG} Acme`, to: `${TAG} Renamed` },
        weight: { from: 5, to: 9 },
        headline: { from: 'Gospel Night Live', to: 'New headline' },
        subline: { from: 'Abuja · Sat 18 October · from ₦5,000', to: null },
        artworkUrl: {
          from: 'https://cdn.example.com/ads/gospel.png',
          to: null,
        },
      });
      expect(Object.keys(d).sort()).toEqual(DETAIL_KEYS);

      await act(c.id, 'schedule');
      await act(c.id, 'pause');
      const again = await http()
        .patch(`${BASE}/${c.id}`)
        .set(asSuper())
        .send({ placement: 'today_slot', endsAt: iso(hoursFromNow(100)) });
      expect(again.status).toBe(200);
      expect(again.body.data.campaign.status).toBe('paused');
      expect(again.body.data.campaign.placement).toBe('today_slot');
      expect(again.body.data.audit).toMatchObject({
        previousStatus: 'paused',
        newStatus: 'paused',
      });
      expect((await auditOf(c.id)).map((r) => r.action)).toEqual([
        'created',
        'updated',
        'scheduled',
        'paused',
        'updated',
      ]);
    });

    it('refuses an edit while scheduled, live or ended, and says to pause first', async () => {
      for (const status of ['scheduled', 'live', 'ended'] as const) {
        const c = await inStatus(status);
        const res = await http()
          .patch(`${BASE}/${c.id}`)
          .set(asSuper())
          .send({ weight: 3 });
        expect([status, res.status]).toEqual([status, 409]);
        expect(res.body.reason).toEqual({
          code: 'not_editable',
          status,
          allowedFrom: ['draft', 'paused'],
        });
        expect((await rowOf(c.id))?.weight).toBe(5);
        expect(await auditOf(c.id)).toHaveLength(status === 'ended' ? 3 : 2);
      }
    });

    it('refuses a patch that changes nothing, and an empty one', async () => {
      const c = await create();
      for (const send of [
        {},
        { weight: 5 },
        { advertiser: `${TAG}   Acme ` },
        { creative: { headline: 'Gospel Night Live' } },
        { creative: {} },
      ]) {
        const res = await http()
          .patch(`${BASE}/${c.id}`)
          .set(asSuper())
          .send(send);
        expect([JSON.stringify(send), res.status]).toEqual([
          JSON.stringify(send),
          400,
        ]);
        expect(res.body.reason).toEqual({ code: 'no_change' });
      }
      expect(await auditOf(c.id)).toHaveLength(1);
    });

    it('applies every create rule to an edit, and changes nothing when it refuses', async () => {
      const c = await create();
      const before = await rowOf(c.id);
      const bads: Json[] = [
        { advertiser: '⠀' },
        { advertiser: `${TAG} \u2014 dash` },
        { placement: 'nowhere' },
        { startsAt: '2031-01-01T09:00:00+01:00' },
        { endsAt: iso(hoursFromNow(1)), startsAt: iso(hoursFromNow(2)) },
        { endsAt: iso(hoursFromNow(-1)) },
        { startsAt: iso(hoursFromNow(1000)) },
        { weight: 0 },
        { weight: 101 },
        { weight: 3.5 },
        { creative: { headline: '​' } },
        { creative: { headline: 'a'.repeat(AD_TEXT_LIMITS.headline + 1) } },
        { creative: { subline: '' } },
        { creative: { ctaLabel: '́' } },
        { creative: { ctaDestination: 'creator' } },
        { creative: { ctaDestinationId: EV.pending } },
        { creative: { ctaDestinationId: MISSING_EVENT } },
        { creative: { ctaDestinationId: 'x' } },
        { creative: { artworkUrl: 'javascript:alert(1)' } },
        { creative: { artworkUrl: 'http://cdn.example.com/a.png' } },
        { status: 'live' },
        { id: MISSING_CAMPAIGN },
        { creative: { campaignId: MISSING_CAMPAIGN } },
        { weight: null },
        { advertiser: null },
      ];
      for (const send of bads) {
        const res = await http()
          .patch(`${BASE}/${c.id}`)
          .set(asSuper())
          .send(send);
        expect([JSON.stringify(send), res.status]).toEqual([
          JSON.stringify(send),
          400,
        ]);
      }
      expect(await rowOf(c.id)).toEqual(before);
      expect(await auditOf(c.id)).toHaveLength(1);
    });

    it('lets text be fixed on a paused campaign whose window or event has since closed, and keeps it paused', async () => {
      const c = await inStatus('paused');
      await prisma.adCampaign.update({
        where: { id: c.id },
        data: { endsAt: hoursFromNow(-1) },
      });
      await prisma.event.update({
        where: { id: EV.open },
        data: { cancelledAt: new Date() },
      });
      const res = await http()
        .patch(`${BASE}/${c.id}`)
        .set(asSuper())
        .send({ creative: { headline: 'Fixed typo' } });
      expect(res.status).toBe(200);
      expect(res.body.data.campaign.status).toBe('paused');
    });

    it('deletes a draft, keeps its history, and then it is a 404', async () => {
      const c = await create();
      const res = await http().delete(`${BASE}/${c.id}`).set(asSuper());
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.data).sort()).toEqual([
        'audit',
        'campaignId',
      ]);
      expect(res.body.data.campaignId).toBe(c.id);
      expect(res.body.data.audit).toMatchObject({
        action: 'deleted',
        previousStatus: 'draft',
        newStatus: null,
        adminId: ADMIN.super,
      });
      expect(Object.keys(res.body.data.audit.changes).sort()).toEqual(
        FIELD_KEYS,
      );
      expect(res.body.data.audit.changes.headline).toEqual({
        from: 'Gospel Night Live',
        to: null,
      });
      expect(await rowOf(c.id)).toBeNull();
      expect(
        await prisma.adCreative.count({ where: { campaignId: c.id } }),
      ).toBe(0);
      expect((await auditOf(c.id)).map((r) => r.action)).toEqual([
        'created',
        'deleted',
      ]);
      expect((await http().get(`${BASE}/${c.id}`).set(asSuper())).status).toBe(
        404,
      );
      expect(
        (await http().delete(`${BASE}/${c.id}`).set(asSuper())).status,
      ).toBe(404);
      expect(await auditOf(c.id)).toHaveLength(2);
    });

    it('refuses to delete anything that is not a draft', async () => {
      for (const status of ['scheduled', 'live', 'paused', 'ended'] as const) {
        const c = await inStatus(status);
        const res = await http().delete(`${BASE}/${c.id}`).set(asSuper());
        expect([status, res.status]).toEqual([status, 409]);
        expect(res.body.reason).toEqual({
          code: 'not_deletable',
          status,
          allowedFrom: ['draft'],
        });
        expect(await rowOf(c.id)).not.toBeNull();
      }
    });
  });

  // ── reads ────────────────────────────────────────────────────────────────

  describe('GET /admin/ads (list)', () => {
    /** Far-future windows keep these fixtures apart from anything else in the table. */
    const Y = (d: string) => `2031-${d}:00Z`;
    let ids: Record<string, string>;
    async function seedList(): Promise<void> {
      ids = {};
      // name, startsAt, endsAt, placement, weight
      const specs: Array<
        [string, string, string, 'tgif_card' | 'today_slot', number]
      > = [
        ['a', '03-01T09:00', '03-05T09:00', 'tgif_card', 1],
        ['b', '03-01T09:00', '03-06T09:00', 'tgif_card', 2],
        ['c', '03-01T09:00', '03-07T09:00', 'today_slot', 3],
        ['d', '03-01T09:00', '03-08T09:00', 'today_slot', 4],
        ['e', '03-02T09:00', '03-09T09:00', 'tgif_card', 5],
        ['f', '03-03T09:00', '03-10T09:00', 'today_slot', 6],
        ['g', '03-04T09:00', '03-11T09:00', 'tgif_card', 7],
      ];
      for (const [name, s, e, placement, weight] of specs) {
        const c = await create({
          advertiser: `${TAG} ${name}`,
          startsAt: Y(s),
          endsAt: Y(e),
          placement,
          weight,
        });
        ids[name] = c.id;
      }
      await act(ids.b, 'schedule');
      await act(ids.c, 'schedule');
      await act(ids.c, 'pause');
      await act(ids.d, 'end');
    }
    const window = { from: '2031-02-01T00:00:00Z', to: '2031-04-01T00:00:00Z' };

    it('pages through every row exactly once in a fixed order, ties on startsAt broken by id', async () => {
      await seedList();
      const rows = await prisma.adCampaign.findMany({
        where: { id: { in: Object.values(ids) } },
        orderBy: [{ startsAt: 'desc' }, { id: 'desc' }],
      });
      const expected = rows.map((r) => r.id);

      for (const perPage of [1, 2, 3, 7, 20]) {
        const seen: string[] = [];
        let page = 1;
        for (;;) {
          const res = await http()
            .get(BASE)
            .query({ ...window, perPage, page })
            .set(asSuper());
          expect(res.status).toBe(200);
          expect(res.body.pagination).toMatchObject({
            currentPage: page,
            perPage,
            total: 7,
          });
          seen.push(...res.body.data.map((x: Json) => x.id));
          if (res.body.pagination.nextPage === null) break;
          expect(res.body.pagination.nextPage).toBe(page + 1);
          page += 1;
        }
        expect([perPage, seen]).toEqual([perPage, expected]);
      }
      const soonest = await http()
        .get(BASE)
        .query({ ...window, sort: 'soonest', perPage: 100 })
        .set(asSuper());
      const asc = (
        await prisma.adCampaign.findMany({
          where: { id: { in: Object.values(ids) } },
          orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
        })
      ).map((r) => r.id);
      expect(soonest.body.data.map((x: Json) => x.id)).toEqual(asc);
      // Same order twice in a row.
      const again = await http()
        .get(BASE)
        .query({ ...window, sort: 'soonest', perPage: 100 })
        .set(asSuper());
      expect(again.body.data.map((x: Json) => x.id)).toEqual(asc);
    });

    it('a row of the list has exactly the campaign keys', async () => {
      await seedList();
      const res = await http()
        .get(BASE)
        .query({ ...window, perPage: 1 })
        .set(asSuper());
      const item = res.body.data[0];
      expect(Object.keys(item).sort()).toEqual([...CAMPAIGN_KEYS].sort());
      expect(Object.keys(item.creative).sort()).toEqual(CREATIVE_KEYS);
      expect(Object.keys(item.event).sort()).toEqual(EVENT_KEYS);
    });

    it('filters by status, placement and phase, alone and together', async () => {
      await seedList();
      const names = (res: request.Response) =>
        res.body.data
          .map((x: Json) => x.advertiser.replace(`${TAG} `, ''))
          .sort();
      const q = (extra: Json) =>
        http()
          .get(BASE)
          .query({ ...window, perPage: 100, ...extra })
          .set(asSuper());
      expect(names(await q({ status: 'draft' }))).toEqual(['a', 'e', 'f', 'g']);
      expect(names(await q({ status: 'scheduled' }))).toEqual(['b']);
      expect(names(await q({ status: 'paused' }))).toEqual(['c']);
      expect(names(await q({ status: 'ended' }))).toEqual(['d']);
      expect(names(await q({ status: 'live' }))).toEqual([]);
      expect(names(await q({ placement: 'today_slot' }))).toEqual([
        'c',
        'd',
        'f',
      ]);
      expect(
        names(await q({ placement: 'tgif_card', status: 'draft' })),
      ).toEqual(['a', 'e', 'g']);
      expect(names(await q({ phase: 'upcoming' }))).toEqual([
        'a',
        'b',
        'c',
        'd',
        'e',
        'f',
        'g',
      ]);
      expect(names(await q({ phase: 'running' }))).toEqual([]);
      expect(names(await q({ phase: 'over' }))).toEqual([]);
    });

    it('filters by window overlap: a campaign that ends exactly at from, or starts exactly at to, is out', async () => {
      await seedList();
      const q = (from: string, to: string) =>
        http().get(BASE).query({ from, to, perPage: 100 }).set(asSuper());
      const n = async (from: string, to: string) =>
        (await q(from, to)).body.pagination.total;
      expect(await n('2031-03-05T09:00:00Z', '2031-03-06T09:00:00Z')).toBe(6); // a ends exactly at from: out
      expect(await n('2031-03-05T08:59:59Z', '2031-03-06T09:00:00Z')).toBe(7);
      expect(await n('2031-02-01T00:00:00Z', '2031-03-01T09:00:00Z')).toBe(0); // starts exactly at to: out
      expect(await n('2031-02-01T00:00:00Z', '2031-03-01T09:00:01Z')).toBe(4);
      expect(await n('2031-03-11T09:00:00Z', '2031-03-12T00:00:00Z')).toBe(0);
      const onlyFrom = await http()
        .get(BASE)
        .query({ from: '2031-03-10T09:00:00Z', perPage: 100 })
        .set(asSuper());
      expect(
        onlyFrom.body.data
          .map((x: Json) => x.advertiser.replace(`${TAG} `, ''))
          .filter((x: string) => x.length === 1)
          .sort(),
      ).toEqual(['g']); // f ends exactly at from: out
    });

    it('phase follows the clock: running and over', async () => {
      const running = await create({
        advertiser: `${TAG} run`,
        startsAt: iso(hoursFromNow(-2)),
        endsAt: iso(hoursFromNow(2)),
      });
      const over = await create({
        advertiser: `${TAG} over`,
        startsAt: iso(hoursFromNow(-2)),
        endsAt: iso(hoursFromNow(2)),
      });
      await prisma.adCampaign.update({
        where: { id: over.id },
        data: { endsAt: hoursFromNow(-1) },
      });
      const r = await http()
        .get(BASE)
        .query({ phase: 'running', perPage: 100 })
        .set(asSuper());
      expect(r.body.data.map((x: Json) => x.id)).toContain(running.id);
      expect(r.body.data.map((x: Json) => x.id)).not.toContain(over.id);
      expect(r.body.data.every((x: Json) => x.phase === 'running')).toBe(true);
      const o = await http()
        .get(BASE)
        .query({ phase: 'over', perPage: 100 })
        .set(asSuper());
      expect(o.body.data.map((x: Json) => x.id)).toContain(over.id);
      expect(o.body.data.every((x: Json) => x.phase === 'over')).toBe(true);
    });

    it('refuses bad query values', async () => {
      const bad: Json[] = [
        { status: 'archived' },
        { placement: 'nowhere' },
        { phase: 'later' },
        { from: '2031-03-01' },
        { to: '2031-03-01T09:00:00+01:00' },
        { from: '2031-03-02T00:00:00Z', to: '2031-03-01T00:00:00Z' },
        { from: '2031-03-01T00:00:00Z', to: '2031-03-01T00:00:00Z' },
        { sort: 'random' },
        { page: 0 },
        { page: 1001 },
        { page: 'x' },
        { perPage: 0 },
        { perPage: 101 },
        { extra: '1' },
      ];
      for (const q of bad) {
        const res = await http().get(BASE).query(q).set(asSuper());
        expect([JSON.stringify(q), res.status]).toEqual([
          JSON.stringify(q),
          400,
        ]);
      }
    });
  });

  describe('GET /admin/ads/:id and the overlap report', () => {
    it('lists the other bookings on the same placement whose window overlaps, heaviest first', async () => {
      const win = {
        startsAt: '2032-05-01T00:00:00Z',
        endsAt: '2032-05-10T00:00:00Z',
      };
      const main = await create({
        ...win,
        advertiser: `${TAG} main`,
        weight: 10,
      });
      const heavy = await create({
        startsAt: '2032-05-02T00:00:00Z',
        endsAt: '2032-05-03T00:00:00Z',
        advertiser: `${TAG} heavy`,
        weight: 90,
      });
      const light = await create({
        startsAt: '2032-04-01T00:00:00Z',
        endsAt: '2032-05-02T00:00:00Z',
        advertiser: `${TAG} light`,
        weight: 3,
      });
      const touching = await create({
        startsAt: '2032-05-10T00:00:00Z',
        endsAt: '2032-05-12T00:00:00Z',
        advertiser: `${TAG} touching`,
      });
      const other = await create({
        ...win,
        advertiser: `${TAG} other`,
        placement: 'today_slot',
      });
      const draft = await create({ ...win, advertiser: `${TAG} draft` });
      const ended = await create({ ...win, advertiser: `${TAG} ended` });
      for (const id of [heavy.id, light.id, touching.id, other.id, ended.id])
        await act(id, 'schedule');
      await act(ended.id, 'end');
      void draft;
      const paused = await create({
        ...win,
        advertiser: `${TAG} paused`,
        weight: 40,
      });
      await act(paused.id, 'schedule');
      await act(paused.id, 'pause');

      const d = (await http().get(`${BASE}/${main.id}`).set(asSuper())).body
        .data;
      expect(
        d.overlapping.map((o: Json) => o.advertiser.replace(`${TAG} `, '')),
      ).toEqual(['heavy', 'paused', 'light']);
      for (const o of d.overlapping)
        expect(Object.keys(o).sort()).toEqual(OVERLAP_KEYS);
      expect(d.overlapping.map((o: Json) => o.weight)).toEqual([90, 40, 3]);
      // A write returns the same overlaps.
      const w = await act(main.id, 'schedule');
      expect(w.body.data.campaign.overlapping.map((o: Json) => o.id)).toEqual(
        d.overlapping.map((o: Json) => o.id),
      );
    });

    it('is the only place the history is, newest first, with who acted', async () => {
      const c = await create();
      await http()
        .patch(`${BASE}/${c.id}`)
        .set(bearer(tokens.reviewer))
        .send({ weight: 8 });
      await act(c.id, 'schedule', tokens.super);
      const d = (
        await http().get(`${BASE}/${c.id}`).set(bearer(tokens.support))
      ).body.data;
      expect(
        d.history.map((h: Json) => [h.action, h.adminRole, h.adminEmail]),
      ).toEqual([
        ['scheduled', 'superadmin', EMAIL('super')],
        ['updated', 'reviewer', EMAIL('reviewer')],
        ['created', 'superadmin', EMAIL('super')],
      ]);
      for (const h of d.history)
        expect(Object.keys(h).sort()).toEqual(AUDIT_KEYS);
      expect(d.history[1].changes).toEqual({ weight: { from: 5, to: 8 } });
    });
  });

  describe('reports', () => {
    it('GET /admin/ads/:id/report gives the window, how much has run, and what was done', async () => {
      const c = await create({
        startsAt: iso(new Date(Date.now() - 30 * 60_000)),
        endsAt: iso(new Date(Date.now() + 90 * 60_000)),
      });
      await act(c.id, 'schedule');
      await act(c.id, 'pause');
      await act(c.id, 'resume');
      const res = await http()
        .get(`${BASE}/${c.id}/report`)
        .set(bearer(tokens.finance));
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.data).sort()).toEqual([
        'activity',
        'campaign',
        'timing',
      ]);
      expect(Object.keys(res.body.data.campaign).sort()).toEqual(
        [...CAMPAIGN_KEYS].sort(),
      );
      expect(Object.keys(res.body.data.timing).sort()).toEqual([
        'elapsedMinutes',
        'remainingMinutes',
        'windowMinutes',
      ]);
      expect(Object.keys(res.body.data.activity).sort()).toEqual([
        'changes',
        'lastActionAt',
        'pauses',
      ]);
      const t = res.body.data.timing;
      expect(t.windowMinutes).toBe(120);
      expect(t.elapsedMinutes).toBe(30);
      expect(t.remainingMinutes).toBe(90);
      expect(res.body.data.activity).toMatchObject({ changes: 4, pauses: 1 });
      expect(typeof res.body.data.activity.lastActionAt).toBe('string');
    });

    it('timing is clamped before the window opens and after it closes', async () => {
      const before = await create();
      const rb = (
        await http().get(`${BASE}/${before.id}/report`).set(asSuper())
      ).body.data.timing;
      expect(rb).toEqual({
        windowMinutes: 1440,
        elapsedMinutes: 0,
        remainingMinutes: 1440,
      });
      await prisma.adCampaign.update({
        where: { id: before.id },
        data: { startsAt: hoursFromNow(-48), endsAt: hoursFromNow(-24) },
      });
      const ra = (
        await http().get(`${BASE}/${before.id}/report`).set(asSuper())
      ).body.data.timing;
      expect(ra).toEqual({
        windowMinutes: 1440,
        elapsedMinutes: 1440,
        remainingMinutes: 0,
      });
    });

    it('the report carries no counter ADS-05 has not built: no views, taps, skips or CTR', async () => {
      const c = await create();
      const text = JSON.stringify([
        (await http().get(`${BASE}/${c.id}/report`).set(asSuper())).body,
        (await http().get(`${BASE}/report`).set(asSuper())).body,
        (await http().get(`${BASE}/${c.id}`).set(asSuper())).body,
      ]);
      expect(text).not.toMatch(
        /"(views?|impressions?|taps?|clicks?|skips?|ctr)"/i,
      );
    });

    it('GET /admin/ads/report counts by status, placement and phase, and every key is present', async () => {
      const w = {
        startsAt: '2033-06-01T00:00:00Z',
        endsAt: '2033-06-05T00:00:00Z',
      };
      const a = await create({ ...w, advertiser: `${TAG} s1` });
      const b = await create({
        ...w,
        advertiser: `${TAG} s2`,
        placement: 'today_slot',
      });
      const c = await create({ ...w, advertiser: `${TAG} s3` });
      await act(b.id, 'schedule');
      await act(c.id, 'schedule');
      await act(c.id, 'pause');
      void a;
      const range = {
        from: '2033-05-01T00:00:00Z',
        to: '2033-07-01T00:00:00Z',
      };
      const res = await http()
        .get(`${BASE}/report`)
        .query(range)
        .set(bearer(tokens.support));
      expect(res.status).toBe(200);
      const r = res.body.data;
      expect(Object.keys(r).sort()).toEqual([
        'byPhase',
        'byPlacement',
        'byStatus',
        'campaigns',
        'filters',
        'generatedAt',
        'servingNow',
      ]);
      expect(Object.keys(r.filters).sort()).toEqual([
        'from',
        'phase',
        'placement',
        'status',
        'to',
      ]);
      expect(r.campaigns).toBe(3);
      expect(r.byStatus).toEqual({
        draft: 1,
        scheduled: 1,
        live: 0,
        paused: 1,
        ended: 0,
      });
      expect(r.byPlacement).toEqual({ tgif_card: 2, today_slot: 1 });
      expect(r.byPhase).toEqual({ upcoming: 3, running: 0, over: 0 });
      expect(r.filters).toEqual({
        placement: null,
        status: null,
        phase: null,
        from: '2033-05-01T00:00:00.000Z',
        to: '2033-07-01T00:00:00.000Z',
      });
      const only = await http()
        .get(`${BASE}/report`)
        .query({ ...range, placement: 'today_slot', status: 'scheduled' })
        .set(asSuper());
      expect(only.body.data.campaigns).toBe(1);
      expect(only.body.data.byStatus).toEqual({
        draft: 0,
        scheduled: 1,
        live: 0,
        paused: 0,
        ended: 0,
      });
      expect(only.body.data.filters).toMatchObject({
        placement: 'today_slot',
        status: 'scheduled',
      });
      const bad = await http()
        .get(`${BASE}/report`)
        .query({ page: 2 })
        .set(asSuper());
      expect(bad.status).toBe(400);
    });

    it('servingNow counts what serving would show, by placement', async () => {
      const read = async () =>
        (await http().get(`${BASE}/report`).set(asSuper())).body.data
          .servingNow;
      const before = await read();
      const c = await inStatus('live', { placement: 'tgif_card' });
      const after = await read();
      expect(after.tgif_card).toBe(before.tgif_card + 1);
      expect(after.today_slot).toBe(before.today_slot);
      await act(c.id, 'pause');
      expect(await read()).toEqual(before);
    });
  });

  // ── concurrency ──────────────────────────────────────────────────────────

  describe('parallel requests', () => {
    it('eight parallel pauses of one live campaign: one 200, seven 409, one audit row', async () => {
      for (let round = 0; round < 3; round += 1) {
        const c = await inStatus('live');
        const results = await Promise.all(
          Array.from({ length: 8 }, () => act(c.id, 'pause')),
        );
        const codes = results.map((r) => r.status).sort();
        expect(codes).toEqual([200, 409, 409, 409, 409, 409, 409, 409]);
        expect((await rowOf(c.id))?.status).toBe('paused');
        expect((await auditOf(c.id)).map((r) => r.action)).toEqual([
          'created',
          'scheduled',
          'paused',
        ]);
      }
    });

    it('parallel schedules of one draft: one winner and one audit row', async () => {
      const c = await create();
      const results = await Promise.all(
        Array.from({ length: 8 }, () => act(c.id, 'schedule')),
      );
      expect(results.map((r) => r.status).sort()).toEqual([
        200, 409, 409, 409, 409, 409, 409, 409,
      ]);
      expect((await auditOf(c.id)).map((r) => r.action)).toEqual([
        'created',
        'scheduled',
      ]);
    });

    it('parallel pause, resume and end of one campaign: one consistent history every round', async () => {
      for (let round = 0; round < 6; round += 1) {
        const c = await inStatus(round % 2 === 0 ? 'live' : 'paused');
        const start = (await rowOf(c.id))!.status;
        const actions = [
          'pause',
          'resume',
          'end',
          'pause',
          'resume',
          'end',
          'pause',
          'resume',
        ];
        const results = await Promise.all(actions.map((a) => act(c.id, a)));
        const applied = (await auditOf(c.id))
          .filter((r) => ['paused', 'resumed', 'ended'].includes(r.action))
          .slice(start === 'paused' ? 1 : 0);
        // One audit row per request that answered 200, and nothing for the others.
        expect(applied).toHaveLength(
          results.filter((r) => r.status === 200).length,
        );
        expect(results.every((r) => r.status === 200 || r.status === 409)).toBe(
          true,
        );
        // The rows chain: each starts where the one before ended, and the last is the stored status.
        let at = start;
        for (const r of applied) {
          expect(r.previousStatus).toBe(at);
          at = r.newStatus!;
        }
        expect((await rowOf(c.id))?.status).toBe(at);
        // `ended` is final: nothing after it.
        const endedAt = applied.findIndex((r) => r.action === 'ended');
        if (endedAt >= 0) expect(applied).toHaveLength(endedAt + 1);
      }
    });

    it('a parallel edit and an end: both cannot both win on a stale read', async () => {
      for (let round = 0; round < 4; round += 1) {
        const c = await create();
        const [edit, end] = await Promise.all([
          http()
            .patch(`${BASE}/${c.id}`)
            .set(asSuper())
            .send({ weight: 8 + round }),
          act(c.id, 'end'),
        ]);
        expect(end.status).toBe(200);
        expect([200, 409]).toContain(edit.status);
        const actions = (await auditOf(c.id)).map((r) => r.action);
        expect(actions.filter((a) => a === 'ended')).toHaveLength(1);
        expect(actions.filter((a) => a === 'updated')).toHaveLength(
          edit.status === 200 ? 1 : 0,
        );
        const row = await rowOf(c.id);
        expect(row?.status).toBe('ended');
        expect(row?.weight).toBe(edit.status === 200 ? 8 + round : 5);
        if (edit.status === 200) {
          // the edit came first: the audit says so
          expect(actions).toEqual(['created', 'updated', 'ended']);
        }
      }
    });

    it('parallel edits of one draft serialise: each audit row starts from the value the one before ended on', async () => {
      const c = await create();
      const weights = [11, 12, 13, 14, 15, 16];
      const results = await Promise.all(
        weights.map((w) =>
          http().patch(`${BASE}/${c.id}`).set(asSuper()).send({ weight: w }),
        ),
      );
      expect(results.every((r) => r.status === 200)).toBe(true);
      const updates = (await auditOf(c.id)).filter(
        (r) => r.action === 'updated',
      );
      expect(updates).toHaveLength(6);
      let at = 5;
      for (const u of updates) {
        const ch = u.changes as { weight: { from: number; to: number } };
        expect(ch.weight.from).toBe(at);
        at = ch.weight.to;
      }
      expect((await rowOf(c.id))?.weight).toBe(at);
    });

    it('parallel deletes of one draft: one 200, the rest 404 or 409, one audit row', async () => {
      const c = await create();
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          http().delete(`${BASE}/${c.id}`).set(asSuper()),
        ),
      );
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.every((r) => [200, 404].includes(r.status))).toBe(true);
      expect((await auditOf(c.id)).map((r) => r.action)).toEqual([
        'created',
        'deleted',
      ]);
    });

    it('parallel creates make separate drafts, each with one audit row', async () => {
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          http().post(BASE).set(asSuper()).send(body()),
        ),
      );
      expect(results.every((r) => r.status === 200)).toBe(true);
      const ids = results.map((r) => r.body.data.campaign.id);
      expect(new Set(ids).size).toBe(6);
      for (const id of ids) expect(await auditOf(id)).toHaveLength(1);
    });
  });

  // ── logs ─────────────────────────────────────────────────────────────────

  describe('what is written to the logs', () => {
    it('never carries the advertiser, on success or on refusal', async () => {
      const secret = `${TAG} Named Person ${Date.now()}`;
      const chunks: string[] = [];
      const capture = (c: unknown): boolean => {
        chunks.push(String(c));
        return true;
      };
      const out = jest
        .spyOn(process.stdout, 'write')
        .mockImplementation(capture);
      const err = jest
        .spyOn(process.stderr, 'write')
        .mockImplementation(capture);
      try {
        const c = await create({ advertiser: secret });
        await act(c.id, 'schedule');
        await act(c.id, 'schedule');
        await http()
          .patch(`${BASE}/${c.id}`)
          .set(asSuper())
          .send({ advertiser: `${secret} \u2014` });
        await http()
          .post(BASE)
          .set(asSuper())
          .send(body({ advertiser: `${secret}`, weight: 0 }));
        await act(c.id, 'end');
        await http().delete(`${BASE}/${c.id}`).set(asSuper());
      } finally {
        out.mockRestore();
        err.mockRestore();
      }
      expect(chunks.join('')).not.toContain('Named Person');
    });
  });
});
