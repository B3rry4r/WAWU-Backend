import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { resolveInternalServiceKey } from '../../common/tests/internal-service-key';
import { VerificationModule } from '../verification.module';

/**
 * The paid two-tick surface, end to end.
 *
 * Buying a tick, the tick going live, a renewal extending rather than
 * restarting the term, an admin granting a perpetual one, and an admin taking
 * one away. Payment runs through the mock Flutterwave adapter that
 * ContentPieceModule already uses for the content unlock, because this
 * reuses that idiom rather than inventing a second one.
 *
 * WAWU ID is written on every grant and revoke, over real HTTP to the local
 * mock, so the ordering (identity first, mirror second) is exercised rather
 * than asserted about.
 *
 * Fixtures are this suite's own accounts under a `77……` id prefix. No seeded
 * row is read or mutated, so this suite is order-independent (README § Test
 * hygiene, option 1).
 */
const MOCK_WAWU_ID_URL =
  process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';
const MOCK_INTERNAL_SERVICE_KEY = resolveInternalServiceKey();

const TEST_ACCESS_SECRET = 'verification-contract-access-secret';
const TEST_REFRESH_SECRET = 'verification-contract-refresh-secret';
const ADMIN_PASSWORD = 'Sup3rSecret!Password';
const ADMIN_SUPER_ID = '77000000-0000-4000-8000-0000000000a1';
const ADMIN_SUPPORT_ID = '77000000-0000-4000-8000-0000000000a2';
const ADMIN_IDS = [ADMIN_SUPER_ID, ADMIN_SUPPORT_ID];
const SUPER_EMAIL = 'verification-super@test.wawu.dev';
const SUPPORT_EMAIL = 'verification-support@test.wawu.dev';

/** Registered fresh at WAWU ID so nothing here depends on a seeded account. */
interface TestAccount {
  sub: string;
  email: string;
  token: string;
}

async function registerAccount(label: string): Promise<TestAccount> {
  const email = `${label}-${Date.now()}-${Math.floor(Math.random() * 100000)}@test.wawu.dev`;
  const phone = `+23480${String(Math.floor(Math.random() * 100000000)).padStart(8, '0')}`;
  const res = await fetch(`${MOCK_WAWU_ID_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fullName: 'Tick Tester',
      email,
      phone,
      password: 'irrelevant-to-the-mock',
      country: 'Nigeria',
    }),
  });
  if (!res.ok) {
    throw new Error(`mock-wawu-id register failed for ${email}: ${res.status}`);
  }
  const body = (await res.json()) as {
    accessToken: string;
    user: { sub?: string; id?: string };
  };
  const sub = body.user.sub ?? body.user.id;
  if (!sub) throw new Error('mock-wawu-id register returned no sub');
  return { sub, email, token: body.accessToken };
}

describe('Verification (two ticks) contract', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let creator: TestAccount;
  let buyer: TestAccount;
  let professional: TestAccount;

  let superToken: string;
  let supportToken: string;

  const envSnapshot: Record<string, string | undefined> = {};
  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function adminLogin(email: string): Promise<string> {
    const res = await http()
      .post('/api/hub/admin/auth/login')
      .send({ email, password: ADMIN_PASSWORD })
      .expect(200);
    return res.body.data.accessToken as string;
  }

  /** Buy a tick the way the app does: init, then verify with the id Flutterwave returned. */
  async function buyTick(
    account: TestAccount,
    kind: 'creator' | 'professional',
  ) {
    const init = await http()
      .post('/api/hub/verification/purchase')
      .set(auth(account.token))
      .send({ kind })
      .expect(200);
    const txRef = init.body.data.flutterwaveConfig.txRef as string;
    const verify = await http()
      .post('/api/hub/verification/purchase/verify')
      .set(auth(account.token))
      .send({ transaction_id: `flw-${txRef}`, tx_ref: txRef })
      .expect(200);
    return { init: init.body.data, verify: verify.body.data, txRef };
  }

  async function ticksAtWawuId(sub: string) {
    const res = await fetch(`${MOCK_WAWU_ID_URL}/internal/users/lookup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Key': MOCK_INTERNAL_SERVICE_KEY,
      },
      body: JSON.stringify({ ids: [sub] }),
    });
    const body = (await res.json()) as {
      data?: Array<{ id: string; verification?: unknown }>;
    };
    return body.data?.[0]?.verification;
  }

  beforeAll(async () => {
    for (const key of [
      'ADMIN_JWT_SECRET',
      'ADMIN_JWT_REFRESH_SECRET',
      'WAWU_ID_INTERNAL_SERVICE_KEY',
      'WAWU_ID_BASE_URL',
    ]) {
      envSnapshot[key] = process.env[key];
    }
    process.env.ADMIN_JWT_SECRET = TEST_ACCESS_SECRET;
    process.env.ADMIN_JWT_REFRESH_SECRET = TEST_REFRESH_SECRET;
    // WawuIdClient reads the key in its constructor and @nestjs/config never
    // overwrites a variable already in process.env, so this has to be set
    // before ConfigModule compiles. The repo `.env` points at the REAL WAWU
    // ID and carries a different key; without this the grant 401s and the
    // failure reads as a verification bug rather than a key mismatch.
    process.env.WAWU_ID_INTERNAL_SERVICE_KEY = MOCK_INTERNAL_SERVICE_KEY;
    process.env.WAWU_ID_BASE_URL = MOCK_WAWU_ID_URL;

    [creator, buyer, professional] = await Promise.all([
      registerAccount('tick-creator'),
      registerAccount('tick-buyer'),
      registerAccount('tick-professional'),
    ]);

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        VerificationModule,
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

    await prisma.userProfile.createMany({
      data: [
        { wawuUserId: creator.sub, accountType: 'creator' },
        { wawuUserId: buyer.sub, accountType: 'user' },
        { wawuUserId: professional.sub, accountType: 'user' },
      ],
    });
    await prisma.professionalProfile.create({
      data: {
        id: '77000000-0000-4000-8000-0000000000b1',
        wawuUserId: professional.sub,
        category: 'legal_services',
        headline: 'Corporate lawyer, 11 years',
        about: 'Company formation and contracts.',
        credentialKind: 'licence',
        status: 'approved',
      },
    });

    const argon2 = await import('argon2');
    const passwordHash = await argon2.hash(ADMIN_PASSWORD);
    await prisma.adminUser.deleteMany({ where: { id: { in: ADMIN_IDS } } });
    await prisma.adminUser.createMany({
      data: [
        {
          id: ADMIN_SUPER_ID,
          email: SUPER_EMAIL,
          name: 'Tick Super',
          role: 'superadmin',
          passwordHash,
        },
        {
          id: ADMIN_SUPPORT_ID,
          email: SUPPORT_EMAIL,
          name: 'Tick Support',
          role: 'support',
          passwordHash,
        },
      ],
    });
    superToken = await adminLogin(SUPER_EMAIL);
    supportToken = await adminLogin(SUPPORT_EMAIL);
  }, 60000);

  afterAll(async () => {
    const subs = [creator.sub, buyer.sub, professional.sub];
    await prisma.verificationPurchase.deleteMany({
      where: { wawuUserId: { in: subs } },
    });
    await prisma.professionalProfile.deleteMany({
      where: { wawuUserId: { in: subs } },
    });
    await prisma.userProfile.deleteMany({ where: { wawuUserId: { in: subs } } });
    await prisma.adminUser.deleteMany({ where: { id: { in: ADMIN_IDS } } });
    await app.close();
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  // ── prices ────────────────────────────────────────────────────────────────

  describe('GET /api/hub/verification/pricing', () => {
    it('quotes both ticks in naira, by the year', async () => {
      const res = await http()
        .get('/api/hub/verification/pricing')
        .set(auth(buyer.token))
        .expect(200);
      expect(res.body.data).toEqual({
        creator: 2000,
        professional: 2000,
        currency: 'NGN',
        termMonths: 12,
      });
    });

    it('follows the configured price rather than a number compiled into a service', async () => {
      await prisma.platformSettings.upsert({
        where: { id: 1 },
        update: { creatorVerificationPriceNgn: 6500 },
        create: { id: 1, creatorVerificationPriceNgn: 6500 },
      });
      try {
        const res = await http()
          .get('/api/hub/verification/pricing')
          .set(auth(buyer.token))
          .expect(200);
        expect(res.body.data.creator).toBe(6500);

        // And the price that is charged moves with it, not just the one shown.
        const init = await http()
          .post('/api/hub/verification/purchase')
          .set(auth(creator.token))
          .send({ kind: 'creator' })
          .expect(200);
        expect(init.body.data.flutterwaveConfig.amount).toBe(6500);
        expect(init.body.data.priceNgn).toBe(6500);
      } finally {
        await prisma.platformSettings.update({
          where: { id: 1 },
          data: { creatorVerificationPriceNgn: 2000 },
        });
        await prisma.verificationPurchase.deleteMany({
          where: { wawuUserId: creator.sub },
        });
      }
    });
  });

  // ── who may buy what ──────────────────────────────────────────────────────

  describe('GET /api/hub/verification/me', () => {
    it('starts with no tick at all, and says which one this account could buy', async () => {
      const res = await http()
        .get('/api/hub/verification/me')
        .set(auth(creator.token))
        .expect(200);
      expect(res.body.data.verification).toEqual({
        creator: { verified: false, expiresAt: null },
        professional: { verified: false, expiresAt: null },
      });
      const byKind = Object.fromEntries(
        res.body.data.eligibility.map(
          (e: { kind: string; allowed: boolean }) => [e.kind, e.allowed],
        ),
      );
      expect(byKind).toEqual({ creator: true, professional: false });
    });

    it('refuses a buyer account both ticks, which is what stops a buyer hosting', async () => {
      const res = await http()
        .get('/api/hub/verification/me')
        .set(auth(buyer.token))
        .expect(200);
      for (const entry of res.body.data.eligibility) {
        expect(entry.allowed).toBe(false);
        expect(typeof entry.reason).toBe('string');
        expect(entry.reason).not.toContain('—');
      }
    });

    it('offers the professional tick to an approved professional profile', async () => {
      const res = await http()
        .get('/api/hub/verification/me')
        .set(auth(professional.token))
        .expect(200);
      const professionalEntry = res.body.data.eligibility.find(
        (e: { kind: string }) => e.kind === 'professional',
      );
      expect(professionalEntry.allowed).toBe(true);
      expect(professionalEntry.priceNgn).toBe(2000);
    });
  });

  describe('POST /api/hub/verification/purchase', () => {
    it('refuses to open a checkout this account could never complete', async () => {
      await http()
        .post('/api/hub/verification/purchase')
        .set(auth(buyer.token))
        .send({ kind: 'creator' })
        .expect(403);
      const rows = await prisma.verificationPurchase.findMany({
        where: { wawuUserId: buyer.sub },
      });
      expect(rows).toHaveLength(0);
    });

    it('400s a kind that is not one of the two', async () => {
      await http()
        .post('/api/hub/verification/purchase')
        .set(auth(creator.token))
        .send({ kind: 'trusted_partner' })
        .expect(400);
    });
  });

  // ── the grant ─────────────────────────────────────────────────────────────

  describe('POST /api/hub/verification/purchase/verify', () => {
    afterEach(async () => {
      await prisma.verificationPurchase.deleteMany({
        where: { wawuUserId: creator.sub },
      });
      await prisma.userProfile.update({
        where: { wawuUserId: creator.sub },
        data: { creatorVerifiedAt: null, creatorVerifiedUntil: null },
      });
    });

    it('grants the tick for a year, writes WAWU ID, and mirrors it here', async () => {
      const before = Date.now();
      const { verify, txRef } = await buyTick(creator, 'creator');

      expect(verify.kind).toBe('creator');
      expect(verify.verification.creator.verified).toBe(true);
      expect(verify.verification.professional.verified).toBe(false);

      const expiresAt = new Date(verify.verification.creator.expiresAt);
      const expected = new Date(before);
      expected.setUTCFullYear(expected.getUTCFullYear() + 1);
      // Within a minute of a year from now. Asserted as a window rather than
      // an instant because the clock moves between the request and here.
      expect(
        Math.abs(expiresAt.getTime() - expected.getTime()),
      ).toBeLessThan(60_000);

      // Identity is the source of truth, and was written.
      const atWawuId = (await ticksAtWawuId(creator.sub)) as {
        creator: { verifiedAt: string | null; verifiedUntil: string | null };
      };
      expect(atWawuId.creator.verifiedAt).not.toBeNull();
      expect(atWawuId.creator.verifiedUntil).toBe(expiresAt.toISOString());

      // And the payment is settled exactly once, with the term recorded on it.
      const row = await prisma.verificationPurchase.findUnique({
        where: { flutterwaveTxRef: txRef },
      });
      expect(row?.status).toBe('completed');
      expect(row?.priceNgn).toBe(2000);
      expect(row?.grantedUntil?.toISOString()).toBe(expiresAt.toISOString());
    });

    it('is idempotent: verifying the same payment twice grants one year, not two', async () => {
      const { verify, txRef } = await buyTick(creator, 'creator');
      const again = await http()
        .post('/api/hub/verification/purchase/verify')
        .set(auth(creator.token))
        .send({ transaction_id: `flw-${txRef}`, tx_ref: txRef })
        .expect(200);
      expect(again.body.data.verification.creator.expiresAt).toBe(
        verify.verification.creator.expiresAt,
      );
    });

    it('extends from the existing expiry on a renewal, so early renewal loses nothing', async () => {
      const existingUntil = new Date('2099-06-01T00:00:00.000Z');
      await prisma.userProfile.update({
        where: { wawuUserId: creator.sub },
        data: {
          creatorVerifiedAt: new Date('2098-06-01T00:00:00.000Z'),
          creatorVerifiedUntil: existingUntil,
        },
      });
      const { verify } = await buyTick(creator, 'creator');
      expect(verify.verification.creator.expiresAt).toBe(
        '2100-06-01T00:00:00.000Z',
      );
    });

    it('grants nothing when the payment did not go through', async () => {
      const init = await http()
        .post('/api/hub/verification/purchase')
        .set(auth(creator.token))
        .send({ kind: 'creator' })
        .expect(200);
      await http()
        .post('/api/hub/verification/purchase/verify')
        .set(auth(creator.token))
        // The mock's documented failure id.
        .send({
          transaction_id: 'mock-flw-tx-fail',
          tx_ref: init.body.data.flutterwaveConfig.txRef,
        })
        .expect(400);

      const me = await http()
        .get('/api/hub/verification/me')
        .set(auth(creator.token))
        .expect(200);
      expect(me.body.data.verification.creator.verified).toBe(false);
    });

    it('404s a reference this account never started', async () => {
      await http()
        .post('/api/hub/verification/purchase/verify')
        .set(auth(creator.token))
        .send({ transaction_id: 'anything', tx_ref: 'mock-content-not-mine' })
        .expect(404);
    });

    it('keeps the two ticks independent: buying one does not confer the other', async () => {
      await buyTick(creator, 'creator');
      const me = await http()
        .get('/api/hub/verification/me')
        .set(auth(creator.token))
        .expect(200);
      expect(me.body.data.verification.creator.verified).toBe(true);
      expect(me.body.data.verification.professional.verified).toBe(false);
    });
  });

  // ── admin grant and revoke ────────────────────────────────────────────────

  describe('POST /api/hub/admin/verification/ticks/:wawuUserId/grant', () => {
    afterEach(async () => {
      await prisma.userProfile.update({
        where: { wawuUserId: professional.sub },
        data: {
          professionalVerifiedAt: null,
          professionalVerifiedUntil: null,
        },
      });
    });

    it('grants a PERPETUAL tick when no expiry is given', async () => {
      const res = await http()
        .post(`/api/hub/admin/verification/ticks/${professional.sub}/grant`)
        .set(auth(superToken))
        .send({ kind: 'professional' })
        .expect(200);
      expect(res.body.data.professional).toEqual({
        verified: true,
        expiresAt: null,
      });

      const atWawuId = (await ticksAtWawuId(professional.sub)) as {
        professional: { verifiedAt: string | null; verifiedUntil: string | null };
      };
      expect(atWawuId.professional.verifiedAt).not.toBeNull();
      expect(atWawuId.professional.verifiedUntil).toBeNull();
    });

    it('grants a dated term when one is given', async () => {
      const res = await http()
        .post(`/api/hub/admin/verification/ticks/${professional.sub}/grant`)
        .set(auth(superToken))
        .send({ kind: 'professional', until: '2099-01-01T00:00:00.000Z' })
        .expect(200);
      expect(res.body.data.professional).toEqual({
        verified: true,
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
    });

    it('refuses support, who reads this surface but decides nothing', async () => {
      await http()
        .post(`/api/hub/admin/verification/ticks/${professional.sub}/grant`)
        .set(auth(supportToken))
        .send({ kind: 'professional' })
        .expect(403);
    });

    it('refuses an unauthenticated caller, and a user token', async () => {
      await http()
        .post(`/api/hub/admin/verification/ticks/${professional.sub}/grant`)
        .send({ kind: 'professional' })
        .expect(401);
      await http()
        .post(`/api/hub/admin/verification/ticks/${professional.sub}/grant`)
        .set(auth(professional.token))
        .send({ kind: 'professional' })
        .expect(401);
    });
  });

  describe('POST /api/hub/admin/verification/ticks/:wawuUserId/revoke', () => {
    it('clears the tick here and at WAWU ID, and leaves the payment record alone', async () => {
      const { txRef } = await buyTick(creator, 'creator');

      const res = await http()
        .post(`/api/hub/admin/verification/ticks/${creator.sub}/revoke`)
        .set(auth(superToken))
        .send({ kind: 'creator' })
        .expect(200);
      expect(res.body.data.creator).toEqual({
        verified: false,
        expiresAt: null,
      });

      const atWawuId = (await ticksAtWawuId(creator.sub)) as {
        creator: { verifiedAt: string | null; verifiedUntil: string | null };
      };
      expect(atWawuId.creator.verifiedAt).toBeNull();
      expect(atWawuId.creator.verifiedUntil).toBeNull();

      // The money record survives a revocation: it happened.
      const row = await prisma.verificationPurchase.findUnique({
        where: { flutterwaveTxRef: txRef },
      });
      expect(row?.status).toBe('completed');

      await prisma.verificationPurchase.deleteMany({
        where: { wawuUserId: creator.sub },
      });
    });

    it('revokes only the tick it was asked about', async () => {
      await http()
        .post(`/api/hub/admin/verification/ticks/${professional.sub}/grant`)
        .set(auth(superToken))
        .send({ kind: 'professional' })
        .expect(200);
      await http()
        .post(`/api/hub/admin/verification/ticks/${professional.sub}/grant`)
        .set(auth(superToken))
        .send({ kind: 'creator' })
        .expect(200);

      const res = await http()
        .post(`/api/hub/admin/verification/ticks/${professional.sub}/revoke`)
        .set(auth(superToken))
        .send({ kind: 'creator' })
        .expect(200);
      expect(res.body.data.creator.verified).toBe(false);
      expect(res.body.data.professional.verified).toBe(true);

      await prisma.userProfile.update({
        where: { wawuUserId: professional.sub },
        data: {
          creatorVerifiedAt: null,
          creatorVerifiedUntil: null,
          professionalVerifiedAt: null,
          professionalVerifiedUntil: null,
        },
      });
    });

    it('404s an account this service has no profile for', async () => {
      await http()
        .post(
          '/api/hub/admin/verification/ticks/77000000-0000-4000-8000-0000000000ff/revoke',
        )
        .set(auth(superToken))
        .send({ kind: 'creator' })
        .expect(404);
    });
  });
});
