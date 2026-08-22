import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import { AppModule } from '../../app.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';

/**
 * Registration / shadow-safety for the two ops-read admin modules.
 *
 * The per-resource contract suites next door boot only their own module graph.
 * That proves the handlers are correct; it does NOT prove they are REACHABLE in
 * the real application, and reachability is the exact thing app.module.ts's
 * ordering comment is about. Express matches routes in registration order, and
 * PartnerServiceController — `@Controller('services')` with a `@Get(':id')`
 * catch-all — has already silently swallowed two sibling routes in this
 * codebase's history. A module that is registered in the wrong place produces a
 * confusing 400 or 404 at runtime and a green test suite.
 *
 * So this file boots the FULL AppModule and asserts both directions:
 *
 *  - the new `/admin/payments/*` and `/admin/creators/*` routes resolve to
 *    their own handlers, rather than being swallowed by anything registered
 *    before them;
 *  - the routes that the ordering already protected still resolve, so
 *    registering two more modules early has not displaced
 *    MentorModule → ServiceApplicationModule → PartnerServiceModule.
 *
 * The `admin` prefix cannot collide in the other direction either — no
 * controller outside `src/admin/` declares one — and that is asserted here too
 * by checking the app's own same-subject routes still answer on their own
 * first segments.
 */

const MOCK_WAWU_ID_URL = process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';

const ADMIN_FINANCE_ID = 'b2000000-0000-4000-8000-000000000001';
const ADMIN_SUPPORT_ID = 'b2000000-0000-4000-8000-000000000002';
const ADMIN_IDS = [ADMIN_FINANCE_ID, ADMIN_SUPPORT_ID];
const FINANCE_EMAIL = 'ops-reads-finance@admin.test.wawu.dev';
const SUPPORT_EMAIL = 'ops-reads-support@admin.test.wawu.dev';
const PASSWORD = 'admin-ops-reads-registration-password';

const TEST_ACCESS_SECRET = 'admin-ops-reads-access-secret-0123456789ab';
const TEST_REFRESH_SECRET = 'admin-ops-reads-refresh-secret-0123456789ab';

const UNKNOWN_ID = 'b2000000-0000-4000-8000-0000000000ff';

async function loginToWawuId(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_WAWU_ID_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) {
    throw new Error(`mock-wawu-id login failed for ${identifier}: ${res.status}`);
  }
  return ((await res.json()) as { accessToken: string }).accessToken;
}

describe('Admin ops-reads registration (full AppModule)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let financeToken: string;
  let supportToken: string;
  let userToken: string;

  const envSnapshot: Record<string, string | undefined> = {};

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    for (const key of ['ADMIN_JWT_SECRET', 'ADMIN_JWT_REFRESH_SECRET']) {
      envSnapshot[key] = process.env[key];
    }
    process.env.ADMIN_JWT_SECRET = TEST_ACCESS_SECRET;
    process.env.ADMIN_JWT_REFRESH_SECRET = TEST_REFRESH_SECRET;

    userToken = await loginToWawuId('user@test.wawu.dev');

    const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      // Same override the protected-registry regression baseline uses: the
      // global limit is 20 req/s and this suite bursts past it. Overriding
      // keeps the assertions about ROUTING from turning into assertions about
      // the throttler.
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/hub');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
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
        { id: ADMIN_FINANCE_ID, email: FINANCE_EMAIL, name: 'Ops Finance', role: 'finance', passwordHash },
        { id: ADMIN_SUPPORT_ID, email: SUPPORT_EMAIL, name: 'Ops Support', role: 'support', passwordHash },
      ],
    });

    const login = async (email: string) => {
      const res = await http()
        .post('/api/hub/admin/auth/login')
        .send({ email, password: PASSWORD })
        .expect(200);
      return res.body.data.accessToken as string;
    };
    financeToken = await login(FINANCE_EMAIL);
    supportToken = await login(SUPPORT_EMAIL);
  }, 60000);

  afterAll(async () => {
    if (prisma) {
      await prisma.adminUser.deleteMany({ where: { id: { in: ADMIN_IDS } } });
    }
    await app?.close();
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  describe('the new admin routes are reachable in the real app', () => {
    it('GET /api/hub/admin/payments/receipts resolves to its own handler', async () => {
      const res = await http()
        .get('/api/hub/admin/payments/receipts')
        .query({ perPage: 1 })
        .set(auth(financeToken))
        .expect(200);
      expect(res.body).toMatchObject({ statusCode: 200, message: 'OK' });
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.pagination).toBeDefined();
    });

    it('GET /api/hub/admin/payments/receipts/:id resolves — a 404 from the SERVICE, not a routing miss', async () => {
      const res = await http()
        .get(`/api/hub/admin/payments/receipts/${UNKNOWN_ID}`)
        .set(auth(financeToken))
        .expect(404);
      // The service's own words. A routing miss would say "Cannot GET …".
      expect(res.body.message).toBe('Payment receipt not found.');
    });

    it('POST /api/hub/admin/payments/receipts/:id/reverify resolves', async () => {
      const res = await http()
        .post(`/api/hub/admin/payments/receipts/${UNKNOWN_ID}/reverify`)
        .set(auth(financeToken))
        .expect(404);
      expect(res.body.message).toBe('Payment receipt not found.');
    });

    it('GET /api/hub/admin/creators resolves to its own handler', async () => {
      const res = await http()
        .get('/api/hub/admin/creators')
        .query({ perPage: 1 })
        .set(auth(supportToken))
        .expect(200);
      expect(res.body).toMatchObject({ statusCode: 200, message: 'OK' });
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('GET /api/hub/admin/creators/:wawuId resolves — a 404 from the SERVICE', async () => {
      const res = await http()
        .get(`/api/hub/admin/creators/${UNKNOWN_ID}`)
        .set(auth(supportToken))
        .expect(404);
      expect(res.body.message).toBe('No account with that WAWU ID is known to this backend.');
    });

    it('the role gates hold under the real guard stack, and a user token is refused', async () => {
      await http().get('/api/hub/admin/payments/receipts').set(auth(supportToken)).expect(403);
      await http().get('/api/hub/admin/creators').set(auth(financeToken)).expect(200);
      await http().get('/api/hub/admin/payments/receipts').set(auth(userToken)).expect(401);
      await http().get('/api/hub/admin/creators').set(auth(userToken)).expect(401);
    });
  });

  describe('nothing that already worked has been displaced', () => {
    it('GET /api/hub/services/mentors is still MentorController, not the /services/:id catch-all', async () => {
      // This is the exact route PartnerServiceController's `@Get(':id')` once
      // swallowed, answering "uuid v4 is expected" instead of a mentor list.
      const res = await http()
        .get('/api/hub/services/mentors')
        .set(auth(userToken))
        .expect(200);
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('GET /api/hub/services still reaches PartnerServiceController', async () => {
      const res = await http().get('/api/hub/services').set(auth(userToken)).expect(200);
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('the app-side creator and webhook surfaces still answer on their own first segments', async () => {
      // `/creator-subscription` is the app's own route for the same subject as
      // `/admin/creators`. Different first segment, so neither can shadow the
      // other — asserted rather than assumed. Whatever it answers a plain user,
      // it answers in its OWN words; a routing miss would say "Cannot GET …".
      const creatorSubscription = await http()
        .get('/api/hub/creator-subscription')
        .set(auth(userToken));
      expect(creatorSubscription.body.message).not.toMatch(/^Cannot GET/);
      // The webhook, unauthenticated and signature-gated: still 401, i.e. still
      // its own controller rather than anything under /admin.
      await http().post('/api/hub/webhooks/flutterwave').send({ event: 'ping' }).expect(401);
    });
  });
});
