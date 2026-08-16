import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { AccountModule } from '../account.module';
import { WAWU_ID_ACCOUNT_GATEWAY, WawuIdAccountGateway } from '../wawu-id-account.gateway';

/**
 * Contract tests for the Account resource (registry.json: DELETE /account,
 * roles: ["any"]). Auth is exercised for real: a real RS256 JWT is minted
 * by the local mock WAWU ID service (mock-wawu-id/server.js, must be
 * running on :4001 -- see conventions.md § Local test environment) and
 * verified for real by this backend's WawuJwtStrategy against its JWKS
 * endpoint. The outbound WAWU-ID-account-deletion call is stubbed via DI
 * override on WAWU_ID_ACCOUNT_GATEWAY (conventions.md's "external calls
 * behind an interface so contract tests can stub them" rule) since no live
 * WAWU ID internal deletion endpoint exists in this sandbox.
 */
const MOCK_WAWU_ID_BASE_URL = process.env.WAWU_ID_BASE_URL_TEST ?? 'http://localhost:4001';
const PLAIN_USER_IDENTIFIER = 'user@test.wawu.dev';
const PLAIN_USER_SUB = '00000000-0000-4000-8000-000000000001';

describe('Account (contract)', () => {
  let app: INestApplication;
  let accessToken: string;
  const mockGateway: jest.Mocked<WawuIdAccountGateway> = {
    scheduleAccountDeletion: jest.fn().mockResolvedValue({ scheduled: true }),
  };

  beforeAll(async () => {
    // Real login against the local mock WAWU ID -- a genuine signed JWT,
    // not a minted/injected one.
    const loginRes = await fetch(`${MOCK_WAWU_ID_BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: PLAIN_USER_IDENTIFIER }),
    });
    if (!loginRes.ok) {
      throw new Error(
        `mock-wawu-id login failed (${loginRes.status}) -- is mock-wawu-id/server.js running on :4001?`,
      );
    }
    const loginBody = (await loginRes.json()) as { accessToken: string };
    accessToken = loginBody.accessToken;

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), WawuAuthModule, AccountModule],
    })
      .overrideProvider(WAWU_ID_ACCOUNT_GATEWAY)
      .useValue(mockGateway)
      .compile();

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

  beforeEach(() => {
    mockGateway.scheduleAccountDeletion.mockClear();
  });

  describe('DELETE /account', () => {
    it('valid request -> 200 with {deletionScheduledAt} ~48h out, and orchestrates WAWU ID deletion', async () => {
      const before = Date.now();

      const res = await request(app.getHttpServer())
        .delete('/api/hub/account')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(res.body).toEqual({
        statusCode: 200,
        message: 'OK',
        data: { deletionScheduledAt: expect.any(String) },
      });

      const scheduledAt = new Date(res.body.data.deletionScheduledAt).getTime();
      const expectedMs = 48 * 60 * 60 * 1000;
      // Allow generous test-runtime slack either side of the 48h mark.
      expect(scheduledAt).toBeGreaterThan(before + expectedMs - 60_000);
      expect(scheduledAt).toBeLessThan(before + expectedMs + 60_000);

      expect(mockGateway.scheduleAccountDeletion).toHaveBeenCalledWith(PLAIN_USER_SUB);
    });

    it('invalid payload (unwhitelisted body field) -> 400', async () => {
      const res = await request(app.getHttpServer())
        .delete('/api/hub/account')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ notPartOfTheContract: true })
        .expect(400);

      expect(res.body.statusCode).toBe(400);
      expect(res.body.data).toBeNull();
    });

    it('missing auth -> 401', async () => {
      const res = await request(app.getHttpServer()).delete('/api/hub/account').expect(401);

      expect(res.body.statusCode).toBe(401);
      expect(res.body.data).toBeNull();
    });

    it('invalid/garbage token -> 401', async () => {
      const res = await request(app.getHttpServer())
        .delete('/api/hub/account')
        .set('Authorization', 'Bearer not-a-real-jwt')
        .expect(401);

      expect(res.body.statusCode).toBe(401);
      expect(res.body.data).toBeNull();
    });
  });
});
