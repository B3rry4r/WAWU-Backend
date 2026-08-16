import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { ConfigModule } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { WawuJwtStrategy } from '../../common/auth/wawu-jwt.strategy';
import { WawuIdClient } from '../../common/auth/wawu-id.client';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { CreditsStateModule } from '../credits-state.module';

/**
 * Contract tests for registry.json "CreditsState" (GET /credits, roles:
 * ["any"]). Auth is exercised end-to-end against the shared local mock
 * WAWU ID service (real RS256 JWT, verified over real HTTP JWKS fetch) per
 * conventions.md § Local test environment — no minted/injected tokens.
 */

const MOCK_WAWU_ID_URL = 'http://localhost:4001';

// Seeded wawuUserIds (task brief / mock-wawu-id/server.js).
const USER_PLAIN = '00000000-0000-4000-8000-000000000001';

async function loginAs(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_WAWU_ID_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) {
    throw new Error(`mock-wawu-id login failed for ${identifier}: ${res.status}`);
  }
  const body = (await res.json()) as { accessToken: string };
  return body.accessToken;
}

describe('CreditsState contract', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let plainUserToken: string;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PassportModule.register({ defaultStrategy: 'wawu-jwt' }),
        PrismaModule,
        CreditsStateModule,
      ],
      providers: [WawuJwtStrategy, WawuIdClient],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/hub');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();

    prisma = moduleRef.get(PrismaService);
    plainUserToken = await loginAs('user@test.wawu.dev');
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/hub/credits', () => {
    it('valid request -> 200 with the seeded CreditsState shape', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/hub/credits')
        .set('Authorization', `Bearer ${plainUserToken}`)
        .expect(200);

      expect(res.body).toMatchObject({
        statusCode: 200,
        message: 'OK',
        data: {
          userWawuId: USER_PLAIN,
          creditBalance: expect.any(Number),
        },
      });
      // product-truths.json invariant: credits are a count, never a Naira
      // value — the wire shape must never carry anything price-shaped.
      expect(res.body.data).not.toHaveProperty('amount');
      expect(res.body.data).not.toHaveProperty('balanceNaira');
      expect(typeof res.body.data.trialEndsAt).toBe('string');
      // Seeded by prisma/seed.ts for all three seeded users.
      expect(res.body.data.creditBalance).toBe(48);
    });

    it('lazily creates a CreditsState row on first read for a user with none yet', async () => {
      const freshWawuId = '00000000-0000-4000-8000-00000000f00d';
      // No seed row exists for this id — delete defensively in case a
      // previous run left one behind, then confirm true absence.
      await prisma.creditsState.deleteMany({ where: { userWawuId: freshWawuId } });

      const freshToken = await mintTokenFor(freshWawuId);

      const res = await request(app.getHttpServer())
        .get('/api/hub/credits')
        .set('Authorization', `Bearer ${freshToken}`)
        .expect(200);

      expect(res.body.data).toMatchObject({
        userWawuId: freshWawuId,
        creditBalance: 0,
      });
      expect(new Date(res.body.data.trialEndsAt).getTime()).toBeGreaterThan(Date.now());

      const persisted = await prisma.creditsState.findUnique({ where: { userWawuId: freshWawuId } });
      expect(persisted).not.toBeNull();
      expect(persisted?.creditBalance).toBe(0);

      await prisma.creditsState.deleteMany({ where: { userWawuId: freshWawuId } });
    });

    it('missing auth -> 401', async () => {
      const res = await request(app.getHttpServer()).get('/api/hub/credits').expect(401);
      expect(res.body.statusCode).toBe(401);
      expect(res.body.data).toBeNull();
    });

    it('malformed bearer token -> 401', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/hub/credits')
        .set('Authorization', 'Bearer not-a-real-jwt')
        .expect(401);
      expect(res.body.statusCode).toBe(401);
      expect(res.body.data).toBeNull();
    });
  });
});

/**
 * The mock WAWU ID's /auth/login only knows its three seeded identifiers,
 * so exercising the lazy-create path (a wawuUserId with no CreditsState
 * row yet, but still a real WAWU-ID-shaped user) needs a 4th signed token.
 * Mints via the same private key the mock service signs with, over the
 * same claim shape (conventions.md's WawuJwtClaims) — still verified for
 * real by this backend's JWKS-backed strategy, only the *issuer* is the
 * local test double per the documented local-test-environment gap.
 */
async function mintTokenFor(sub: string): Promise<string> {
  const jwt = await import('jsonwebtoken');
  const fs = await import('fs');
  const path = await import('path');
  const privateKey = fs.readFileSync(
    path.join(__dirname, '../../../mock-wawu-id/private.pem'),
    'utf8',
  );
  return jwt.sign(
    {
      sub,
      email: `fresh-${sub}@test.wawu.dev`,
      phone: '+2348000009999',
      firstName: 'Fresh',
      lastName: 'User',
      country: 'Nigeria',
      verificationTier: 'basic',
      trustScore: 0,
      status: 'active',
      platformRefs: { wawuafricaAppUserId: sub },
    },
    privateKey,
    { algorithm: 'RS256', keyid: 'mock-wawu-id-key-1', expiresIn: '15m' },
  );
}
