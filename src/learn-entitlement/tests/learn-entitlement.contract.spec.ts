import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ConfigModule } from '@nestjs/config';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { LearnEntitlementModule } from '../learn-entitlement.module';

// Seeded WAWU IDs — mirror mock-wawu-id/server.js and prisma/seed.ts exactly
// (see WAWU-Hub-API build task brief).
const USER_PLAIN = '00000000-0000-4000-8000-000000000001'; // plain user, enrolled in the export course via seed
const USER_CREATOR_BASIC = '00000000-0000-4000-8000-000000000002'; // creator, no enrollments seeded
const USER_CREATOR_PRO = '00000000-0000-4000-8000-000000000003'; // creator, no enrollments seeded

const LEARN_COURSE_EXPORT = '50000000-0000-4000-8000-000000000001';

const MOCK_WAWU_ID_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_WAWU_ID_BASE = `http://localhost:${MOCK_WAWU_ID_PORT}`;

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
  const res = await fetch(`${MOCK_WAWU_ID_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) {
    throw new Error(
      `mock-wawu-id login failed for ${identifier}: ${res.status}`,
    );
  }
  const body = (await res.json()) as { accessToken: string };
  return body.accessToken;
}

describe('LearnEntitlement (contract)', () => {
  let app: INestApplication;
  let mockWawuId: ChildProcess | undefined;
  let ownedMockWawuId = false;

  let plainUserToken: string;
  let basicCreatorToken: string;
  let proCreatorToken: string;

  beforeAll(async () => {
    // Reuse an already-running mock WAWU ID if present, otherwise spawn one
    // for this test run (conventions.md § Local test environment).
    const alreadyUp = await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`, 1000);
    if (!alreadyUp) {
      mockWawuId = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '../../../mock-wawu-id'),
        env: { ...process.env, MOCK_WAWU_ID_PORT },
        stdio: 'ignore',
      });
      ownedMockWawuId = true;
      const up = await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`);
      if (!up) {
        throw new Error('mock-wawu-id did not become healthy in time');
      }
    }

    plainUserToken = await login('user@test.wawu.dev');
    basicCreatorToken = await login('creator-basic@test.wawu.dev');
    proCreatorToken = await login('creator-pro@test.wawu.dev');

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        LearnEntitlementModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
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
  }, 30000);

  afterAll(async () => {
    await app?.close();
    if (ownedMockWawuId && mockWawuId) {
      mockWawuId.kill();
    }
  });

  describe('GET /learn/entitlement', () => {
    it('returns 0 free-course slots for a plain user, but still reports seeded enrollments (200)', async () => {
      const res = await request(app.getHttpServer())
        .get('/learn/entitlement')
        .set('Authorization', `Bearer ${plainUserToken}`)
        .expect(200);

      expect(res.body.statusCode).toBe(200);
      expect(res.body.data).toEqual({
        freeCoursesTotal: 0,
        freeCoursesUsed: 0,
        enrolledCourseIds: [LEARN_COURSE_EXPORT],
      });
    });

    it('returns 1 free-course slot for a creator account (200)', async () => {
      const res = await request(app.getHttpServer())
        .get('/learn/entitlement')
        .set('Authorization', `Bearer ${basicCreatorToken}`)
        .expect(200);

      expect(res.body.data).toEqual({
        freeCoursesTotal: 1,
        freeCoursesUsed: 0,
        enrolledCourseIds: [],
      });
    });

    it('returns the SAME 1 slot for every other creator, because the tier ladder is gone (200)', async () => {
      // This creator was on a plan that bought 2. The plan no longer exists,
      // and the ladder collapsed to the floor every creator already had.
      const res = await request(app.getHttpServer())
        .get('/learn/entitlement')
        .set('Authorization', `Bearer ${proCreatorToken}`)
        .expect(200);

      expect(res.body.data).toEqual({
        freeCoursesTotal: 1,
        freeCoursesUsed: 0,
        enrolledCourseIds: [],
      });
    });

    it('401s with no Authorization header', async () => {
      await request(app.getHttpServer()).get('/learn/entitlement').expect(401);
    });

    it('401s with a malformed bearer token', async () => {
      await request(app.getHttpServer())
        .get('/learn/entitlement')
        .set('Authorization', 'Bearer not-a-real-jwt')
        .expect(401);
    });
  });
});
