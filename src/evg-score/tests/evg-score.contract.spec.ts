import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { EvgScoreModule } from '../evg-score.module';
import { startTestJwksServer, TestJwksServer } from './test-jwks-server';

// Seeded wawuUserIds (prisma/seed.ts) — shared fixtures per Phase 5 build
// instructions, not invented.
const USER_PLAIN = '00000000-0000-4000-8000-000000000001'; // plain user, no EvgScore row
const USER_CREATOR_BASIC = '00000000-0000-4000-8000-000000000002'; // score 1240
const USER_CREATOR_PRO = '00000000-0000-4000-8000-000000000003'; // score 5310

function baseClaims(sub: string) {
  return {
    sub,
    email: `${sub}@test.wawu.dev`,
    phone: '+2348000000000',
    firstName: 'Test',
    lastName: 'User',
    country: 'Nigeria',
    verificationTier: 'basic',
    trustScore: 10,
    status: 'active',
  };
}

describe('EvgScore contract', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwks: TestJwksServer;
  let authHeader: string;

  beforeAll(async () => {
    // WawuJwtStrategy reads WAWU_ID_JWKS_URL from ConfigService at module
    // construction time — must be set before Test.createTestingModule()
    // compiles the module tree.
    jwks = await startTestJwksServer();
    process.env.WAWU_ID_JWKS_URL = jwks.jwksUrl;

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, WawuAuthModule, EvgScoreModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/hub');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();

    prisma = moduleRef.get(PrismaService);
    authHeader = `Bearer ${jwks.signToken(baseClaims(USER_PLAIN))}`;
  });

  afterAll(async () => {
    await app.close();
    await jwks.close();
  });

  describe('GET /creators/:wawuId/evg', () => {
    it('returns the creator EvgScore for a valid authenticated request', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/hub/creators/${USER_CREATOR_BASIC}/evg`)
        .set('Authorization', authHeader)
        .expect(200);

      expect(res.body).toEqual({
        statusCode: 200,
        message: 'OK',
        data: {
          creatorWawuId: USER_CREATOR_BASIC,
          score: 1240,
          updatedAt: expect.any(String),
        },
      });
    });

    it('returns a different creator\'s own score (Pro tier)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/hub/creators/${USER_CREATOR_PRO}/evg`)
        .set('Authorization', authHeader)
        .expect(200);

      expect(res.body.data).toEqual({
        creatorWawuId: USER_CREATOR_PRO,
        score: 5310,
        updatedAt: expect.any(String),
      });
    });

    it('404s for a well-formed wawuId with no EvgScore row', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/hub/creators/${USER_PLAIN}/evg`)
        .set('Authorization', authHeader)
        .expect(404);

      expect(res.body).toEqual({
        statusCode: 404,
        message: expect.any(String),
        data: null,
      });
    });

    it('400s on a malformed wawuId (invalid payload)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/hub/creators/not-a-uuid/evg')
        .set('Authorization', authHeader)
        .expect(400);

      expect(res.body).toEqual({
        statusCode: 400,
        message: expect.any(String),
        data: null,
      });
    });

    it('401s with no Authorization header', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/hub/creators/${USER_CREATOR_BASIC}/evg`)
        .expect(401);

      expect(res.body).toEqual({
        statusCode: 401,
        message: expect.any(String),
        data: null,
      });
    });

    it('401s with a garbage bearer token', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/hub/creators/${USER_CREATOR_BASIC}/evg`)
        .set('Authorization', 'Bearer not-a-real-jwt')
        .expect(401);

      expect(res.body).toEqual({
        statusCode: 401,
        message: expect.any(String),
        data: null,
      });
    });
  });

  // Sanity check the seed fixtures this suite depends on are actually
  // present in whatever DATABASE_URL the test run points at.
  it('sanity: prisma is connected to a DB with the expected seeded rows', async () => {
    const rows = await prisma.evgScore.findMany({
      where: { creatorWawuId: { in: [USER_CREATOR_BASIC, USER_CREATOR_PRO] } },
    });
    expect(rows).toHaveLength(2);
  });
});
