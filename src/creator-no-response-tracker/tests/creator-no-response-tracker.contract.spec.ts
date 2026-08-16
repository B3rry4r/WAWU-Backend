import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ConfigModule } from '@nestjs/config';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { CreatorNoResponseTrackerModule } from '../creator-no-response-tracker.module';

// Seeded wawuUserIds — mirrors mock-wawu-id/server.js's USERS map and
// prisma/seed.ts, per the task brief.
const PLAIN_USER_EMAIL = 'user@test.wawu.dev'; // plain user, no CreatorState/UserProfile.accountType=user
const CREATOR_BASIC_EMAIL = 'creator-basic@test.wawu.dev'; // basic creator, kyc pending, seeded tracker noResponseRatePct=0
const CREATOR_PRO_EMAIL = 'creator-pro@test.wawu.dev'; // pro creator, kyc approved, seeded tracker noResponseRatePct=4.2

const MOCK_WAWU_ID_BASE_URL = process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';

async function loginAs(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_WAWU_ID_BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) {
    throw new Error(`mock-wawu-id login failed for ${identifier}: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { accessToken: string };
  return body.accessToken;
}

describe('CreatorNoResponseTracker contract — GET /api/hub/dm/response-stats', () => {
  let app: INestApplication;
  let plainUserToken: string;
  let basicCreatorToken: string;
  let proCreatorToken: string;

  beforeAll(async () => {
    [plainUserToken, basicCreatorToken, proCreatorToken] = await Promise.all([
      loginAs(PLAIN_USER_EMAIL),
      loginAs(CREATOR_BASIC_EMAIL),
      loginAs(CREATOR_PRO_EMAIL),
    ]);

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        CreatorNoResponseTrackerModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/hub');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('valid request (Pro creator) -> 200 with the contracted CreatorNoResponseTracker shape', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/hub/dm/response-stats')
      .set('Authorization', `Bearer ${proCreatorToken}`)
      .expect(200);

    expect(res.body).toEqual({
      statusCode: 200,
      message: 'OK',
      data: {
        creatorWawuId: '00000000-0000-4000-8000-000000000003',
        noResponseRatePct: 4.2,
        penaltyState: 'none',
        dmDisabledUntil: null,
      },
    });
  });

  it('valid request (Basic creator) -> 200 with the contracted shape', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/hub/dm/response-stats')
      .set('Authorization', `Bearer ${basicCreatorToken}`)
      .expect(200);

    expect(res.body.data).toMatchObject({
      creatorWawuId: '00000000-0000-4000-8000-000000000002',
      penaltyState: 'none',
    });
    expect(typeof res.body.data.noResponseRatePct).toBe('number');
  });

  it('invalid payload (unexpected query param, forbidNonWhitelisted) -> 400', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/hub/dm/response-stats')
      .query({ bogus: 'not-part-of-the-contract' })
      .set('Authorization', `Bearer ${proCreatorToken}`)
      .expect(400);

    expect(res.body).toMatchObject({ statusCode: 400, data: null });
  });

  it('missing auth -> 401', async () => {
    const res = await request(app.getHttpServer()).get('/api/hub/dm/response-stats').expect(401);

    expect(res.body).toMatchObject({ statusCode: 401, data: null });
  });

  it('wrong role (plain user account, valid auth) -> 403', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/hub/dm/response-stats')
      .set('Authorization', `Bearer ${plainUserToken}`)
      .expect(403);

    expect(res.body).toMatchObject({ statusCode: 403, data: null });
  });
});
