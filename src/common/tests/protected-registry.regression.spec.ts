import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import { AppModule } from '../../app.module';
import { PrismaService } from '../prisma/prisma.service';
import { AllExceptionsFilter } from '../filters/all-exceptions.filter';
import { ResponseInterceptor } from '../interceptors/response.interceptor';

/**
 * PHASE 4.5 — REGRESSION BASELINE (admin-surface-extension pipeline).
 *
 * Generated FROM .pipeline/protected-registry.json, not from the source. It
 * pins the four behaviours an admin layer is most likely to break, each one
 * named in that registry:
 *
 *   1. `frameworkProfile.successShape` / `.errorShape` — the two envelopes,
 *      including hazard H-3 (a 201 response carries statusCode 200 in the
 *      BODY; the shipped app parses that).
 *   2. `auth` — WawuAuthGuard behaviour on the protected surface, and the
 *      fact that all three interim operator mechanisms (`ADMIN_WAWU_USER_IDS`
 *      allowlist, `x-wawu-admin-key`) are UNREACHABLE in every checked-in
 *      configuration (`auth.adminAuthToday`).
 *   3. Hazard H-4 — the five list endpoints that return a BARE ARRAY unless a
 *      paging param is supplied. Both shapes are asserted for all five.
 *   4. Hazard H-2 — module registration ORDER in app.module.ts:90-100.
 *      `PartnerServiceController` is `@Controller('services')` with a
 *      `@Get(':id')` catch-all; MentorModule and ServiceApplicationModule
 *      must stay registered before it or `/services/mentors` and
 *      `/services/applications` get swallowed as `:id`.
 *
 * Unlike every other spec in this repo, this one boots the FULL AppModule —
 * that is the point: registration order is only observable through the real
 * module graph. ThrottlerGuard is overridden because the global limit is 20
 * requests/second (app.module.ts:63-66) and this suite is a burst.
 *
 * This file changes no application code. A red test here means the protected
 * registry is wrong and a human must correct it — it is never licence to
 * "fix" the backend.
 */

const MOCK_WAWU_ID_URL = process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';

// Seeded wawuUserIds (mock-wawu-id/server.js + prisma/seed.ts).
const USER_PLAIN = '00000000-0000-4000-8000-000000000001';

// A syntactically well-formed uuid v4 that matches no row anywhere.
const ABSENT_UUID = '9f000000-0000-4000-8000-0000000004f5';

// Fixture owned by this suite only (README § Test hygiene rules, rule 1).
const REGRESSION_PRODUCT_ID = 'phase45-regression-product';

/** registry.endpoints where roles == ["any-authenticated"] and method == GET. */
const AUTHENTICATED_GET_ENDPOINTS = [
  '/api/hub/users/me',
  '/api/hub/creator/state',
  '/api/hub/credits',
  '/api/hub/services',
  '/api/hub/services/mentors',
  '/api/hub/services/applications',
  '/api/hub/verification/submissions',
  '/api/hub/kyc',
  '/api/hub/notifications',
  '/api/hub/learn/playbook',
];

/** registry.endpoints where roles == ["public-unauthenticated"]. */
const PUBLIC_GET_ENDPOINTS = ['/api/hub/health', '/api/hub/learn/courses', '/api/hub/learn/guides'];

/** Hazard H-4 — path + whether the caller must be authenticated. */
const BARE_ARRAY_ENDPOINTS: { path: string; auth: boolean }[] = [
  { path: '/api/hub/services', auth: true },
  { path: '/api/hub/services/mentors', auth: true },
  { path: '/api/hub/learn/courses', auth: false },
  { path: '/api/hub/learn/guides', auth: false },
  { path: '/api/hub/verification/submissions', auth: true },
];

async function loginAs(identifier: string): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await fetch(`${MOCK_WAWU_ID_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) {
    throw new Error(`mock-wawu-id login failed for ${identifier}: ${res.status}`);
  }
  return (await res.json()) as { accessToken: string; refreshToken: string };
}

/**
 * A structurally perfect RS256 token signed by a key that is NOT in WAWU ID's
 * JWKS — proves the strategy verifies the signature rather than the shape.
 */
async function tokenSignedByAForeignKey(): Promise<string> {
  const jwt = await import('jsonwebtoken');
  const { generateKeyPairSync } = await import('crypto');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return jwt.sign({ sub: USER_PLAIN, status: 'active' }, privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, {
    algorithm: 'RS256',
    keyid: 'mock-wawu-id-key-1',
    expiresIn: '15m',
  });
}

describe('Protected registry regression baseline', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let userToken: string;
  let creatorProToken: string;
  let foreignKeyToken: string;

  const envSnapshot: Record<string, string | undefined> = {};

  beforeAll(async () => {
    // registry.auth.adminAuthToday: both interim operator mechanisms are
    // absent from .env/.env.example/README. Other specs in this --runInBand
    // suite set them on the shared process.env, so pin the checked-in
    // configuration here and put it back in afterAll.
    for (const key of ['ADMIN_WAWU_USER_IDS', 'WAWU_ADMIN_KEY']) {
      envSnapshot[key] = process.env[key];
      delete process.env[key];
    }

    ({ accessToken: userToken } = await loginAs('user@test.wawu.dev'));
    ({ accessToken: creatorProToken } = await loginAs('creator-pro@test.wawu.dev'));
    foreignKeyToken = await tokenSignedByAForeignKey();

    const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      // Global rate limit is 20 req/s (app.module.ts:63-66); this suite bursts
      // well past that. Overriding it keeps the assertions about auth and
      // response shape from turning into assertions about the throttler.
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/hub');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();

    prisma = moduleRef.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.marketplaceSave.deleteMany({ where: { productId: REGRESSION_PRODUCT_ID } });
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await app.close();
  });

  describe('success envelope (frameworkProfile.successShape)', () => {
    it('wraps a plain return value as {statusCode, message, data}', async () => {
      const res = await request(app.getHttpServer()).get('/api/hub/health').expect(200);
      expect(res.body).toEqual({
        statusCode: 200,
        message: 'OK',
        data: { ok: true, service: 'wawu-hub-api' },
      });
    });

    it('H-3: a 201 response still carries statusCode 200 in the BODY', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/hub/marketplace/saves')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ productId: REGRESSION_PRODUCT_ID, shop: 'basket' })
        .expect(201);
      expect(res.body.statusCode).toBe(200);
      expect(res.body.message).toBe('OK');
      expect(res.body.data).toMatchObject({ productId: REGRESSION_PRODUCT_ID, shop: 'basket' });
    });

    it('renders a Paginated<T> service return as data[] + a pagination block', async () => {
      const res = await request(app.getHttpServer()).get('/api/hub/learn/courses?page=1&perPage=2').expect(200);
      expect(res.body.statusCode).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(Object.keys(res.body.pagination).sort()).toEqual(['currentPage', 'nextPage', 'perPage', 'total']);
      expect(res.body.pagination.currentPage).toBe(1);
      expect(res.body.pagination.perPage).toBe(2);
      expect(typeof res.body.pagination.total).toBe('number');
      // nextPage is `currentPage + 1` or null (response.interceptor.ts:34).
      expect(res.body.pagination.nextPage === null || typeof res.body.pagination.nextPage === 'number').toBe(true);
    });
  });

  describe('error envelope (frameworkProfile.errorShape)', () => {
    it('is exactly {statusCode, message, data:null} on a 401', async () => {
      const res = await request(app.getHttpServer()).get('/api/hub/users/me').expect(401);
      expect(Object.keys(res.body).sort()).toEqual(['data', 'message', 'statusCode']);
      expect(res.body.statusCode).toBe(401);
      expect(typeof res.body.message).toBe('string');
      expect(res.body.data).toBeNull();
    });

    it('collapses a class-validator failure to the FIRST message, as a string', async () => {
      const res = await request(app.getHttpServer()).get('/api/hub/learn/courses?page=0').expect(400);
      expect(typeof res.body.message).toBe('string');
      expect(Array.isArray(res.body.message)).toBe(false);
      expect(res.body.data).toBeNull();
    });

    it('rejects a non-whitelisted query property with a 400', async () => {
      const res = await request(app.getHttpServer()).get('/api/hub/learn/courses?notAField=1').expect(400);
      expect(res.body.data).toBeNull();
    });

    it('returns the same envelope for an unrouted path', async () => {
      const res = await request(app.getHttpServer()).get('/api/hub/definitely-not-a-route').expect(404);
      expect(res.body.statusCode).toBe(404);
      expect(res.body.data).toBeNull();
    });
  });

  describe('auth behaviour (registry.auth)', () => {
    it.each(AUTHENTICATED_GET_ENDPOINTS)('401s %s with no Authorization header', async (path) => {
      await request(app.getHttpServer()).get(path).expect(401);
    });

    it.each(AUTHENTICATED_GET_ENDPOINTS)('401s %s with a malformed bearer token', async (path) => {
      await request(app.getHttpServer()).get(path).set('Authorization', 'Bearer not-a-jwt').expect(401);
    });

    it('401s a well-formed RS256 token signed by a key outside WAWU ID JWKS', async () => {
      await request(app.getHttpServer())
        .get('/api/hub/users/me')
        .set('Authorization', `Bearer ${foreignKeyToken}`)
        .expect(401);
    });

    it.each(PUBLIC_GET_ENDPOINTS)('serves %s with NO token at all', async (path) => {
      await request(app.getHttpServer()).get(path).expect(200);
    });

    it('accepts a real WAWU ID access token on GET /users/me', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/hub/users/me')
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);
      expect(res.body.data.sub).toBe(USER_PLAIN);
    });

    it('accepts a real WAWU ID access token on GET /creator/state', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/hub/creator/state')
        .set('Authorization', `Bearer ${creatorProToken}`)
        .expect(200);
      expect(res.body.data).toMatchObject({ tier: expect.any(String), subscriptionPaid: expect.any(Boolean) });
    });
  });

  describe('interim operator mechanisms are unreachable (registry.auth.adminAuthToday)', () => {
    it('403s POST /kyc/:id/review for a normal user (ADMIN_WAWU_USER_IDS unset)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/hub/kyc/${ABSENT_UUID}/review`)
        .set('Authorization', `Bearer ${creatorProToken}`)
        .send({ decision: 'approved' })
        .expect(403);
      expect(res.body.data).toBeNull();
    });

    it('403s POST /verification/submissions/:id/review for a normal user', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/hub/verification/submissions/${ABSENT_UUID}/review`)
        .set('Authorization', `Bearer ${creatorProToken}`)
        .send({ decision: 'approved' })
        .expect(403);
      expect(res.body.data).toBeNull();
    });

    it('401s POST /learn/guides — AdminKeyGuard fails closed with WAWU_ADMIN_KEY unset', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/hub/learn/guides')
        .send({ title: 'x', kind: 'guide' })
        .expect(401);
      expect(res.body.data).toBeNull();
    });

    it('401s PATCH /learn/playbook even for an authenticated user', async () => {
      await request(app.getHttpServer())
        .patch('/api/hub/learn/playbook')
        .set('Authorization', `Bearer ${creatorProToken}`)
        .send({ title: 'x' })
        .expect(401);
    });
  });

  describe('H-4: the five dual-shape list endpoints', () => {
    it.each(BARE_ARRAY_ENDPOINTS)('$path returns a BARE ARRAY with no paging params', async ({ path, auth }) => {
      const req = request(app.getHttpServer()).get(path);
      if (auth) req.set('Authorization', `Bearer ${creatorProToken}`);
      const res = await req.expect(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body).not.toHaveProperty('pagination');
    });

    it.each(BARE_ARRAY_ENDPOINTS)('$path switches to the Paginated envelope with ?page/?perPage', async ({ path, auth }) => {
      const req = request(app.getHttpServer()).get(`${path}?page=1&perPage=1`);
      if (auth) req.set('Authorization', `Bearer ${creatorProToken}`);
      const res = await req.expect(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.pagination).toMatchObject({
        currentPage: 1,
        perPage: 1,
        total: expect.any(Number),
      });
    });
  });

  describe('H-2: /services/:id catch-all ordering (app.module.ts:90-100)', () => {
    it('GET /services/mentors is the mentor list, NOT :id === "mentors"', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/hub/services/mentors')
        .set('Authorization', `Bearer ${creatorProToken}`)
        .expect(200);
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('GET /services/applications is the applications list, NOT :id === "applications"', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/hub/services/applications')
        .set('Authorization', `Bearer ${creatorProToken}`)
        .expect(200);
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('the :id catch-all is still reachable — an unknown uuid v4 404s', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/hub/services/${ABSENT_UUID}`)
        .set('Authorization', `Bearer ${creatorProToken}`)
        .expect(404);
      expect(res.body.data).toBeNull();
    });

    it('the :id catch-all still rejects a non-uuid with a 400', async () => {
      await request(app.getHttpServer())
        .get('/api/hub/services/not-a-uuid')
        .set('Authorization', `Bearer ${creatorProToken}`)
        .expect(400);
    });

    it('GET /services/mentors/:id is not swallowed by the catch-all either', async () => {
      await request(app.getHttpServer())
        .get(`/api/hub/services/mentors/${ABSENT_UUID}`)
        .set('Authorization', `Bearer ${creatorProToken}`)
        .expect(404);
    });
  });
});
