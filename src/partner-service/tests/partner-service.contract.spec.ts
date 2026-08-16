import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { PartnerServiceModule } from '../partner-service.module';

/**
 * Contract tests for registry.json § PartnerService:
 *   GET  /services                (roles: any)
 *   GET  /services/:id            (roles: any)
 *   POST /services/:id/notify-me  (roles: any)
 *
 * Auth: a real RS256 handshake against the local mock WAWU ID service
 * (mock-wawu-id/server.js), matching conventions.md § Local test environment
 * — spawned for the duration of this suite and torn down after. Seeded
 * wawuUserIds/roles per mock-wawu-id/server.js:
 *   ...001 = plain user, ...002 = Basic creator (kyc pending),
 *   ...003 = Pro creator (kyc approved).
 *
 * PartnerService fixtures come from prisma/seed.ts (already applied to
 * wawu_hub_test):
 *   30000000-0000-4000-8000-000000000001 "CAC Business Registration"       status=live
 *   30000000-0000-4000-8000-000000000002 "NEPC Export License"             status=live
 *   30000000-0000-4000-8000-000000000003 "SEEDED: WAWU Trademark Fast-Track" status=coming
 */

const MOCK_WAWU_ID_PORT = 4001;
const MOCK_WAWU_ID_URL = `http://localhost:${MOCK_WAWU_ID_PORT}`;
const SERVICE_CAC_ID = '30000000-0000-4000-8000-000000000001';
const SERVICE_NEPC_ID = '30000000-0000-4000-8000-000000000002';
const SERVICE_TRADEMARK_ID = '30000000-0000-4000-8000-000000000003';
const NONEXISTENT_UUID = '30000000-0000-4000-8000-00000000ffff';

let mockWawuId: ChildProcess | undefined;
let app: INestApplication;
let userToken: string;

async function isMockWawuIdUp(): Promise<boolean> {
  try {
    const res = await fetch(`${MOCK_WAWU_ID_URL}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForMockWawuId(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await isMockWawuIdUp()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('mock-wawu-id did not become healthy in time');
}

async function loginAs(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_WAWU_ID_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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

beforeAll(async () => {
  process.env.WAWU_ID_JWKS_URL = `${MOCK_WAWU_ID_URL}/.well-known/jwks.json`;

  // Reuse an already-running mock WAWU ID instance (e.g. another agent's
  // sandbox process on the shared default port) rather than colliding on
  // the port; only spawn — and only tear down — one of our own if needed.
  if (!(await isMockWawuIdUp())) {
    mockWawuId = spawn('node', ['server.js'], {
      cwd: path.join(__dirname, '../../../mock-wawu-id'),
      env: { ...process.env, MOCK_WAWU_ID_PORT: String(MOCK_WAWU_ID_PORT) },
      stdio: 'ignore',
    });
  }
  await waitForMockWawuId();
  userToken = await loginAs('user@test.wawu.dev');

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true }),
      PrismaModule,
      WawuAuthModule,
      PartnerServiceModule,
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
}, 30000);

afterAll(async () => {
  await app?.close();
  mockWawuId?.kill();
});

describe('GET /api/hub/services', () => {
  it('valid request -> 200 with contracted PartnerService[] shape', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/hub/services')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.statusCode).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    const ids = res.body.data.map((s: { id: string }) => s.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        SERVICE_CAC_ID,
        SERVICE_NEPC_ID,
        SERVICE_TRADEMARK_ID,
      ]),
    );

    const cac = res.body.data.find(
      (s: { id: string }) => s.id === SERVICE_CAC_ID,
    );
    expect(cac).toMatchObject({
      name: 'CAC Business Registration',
      tagline: 'Register your business with CAC in days, not months.',
      icon: 'building-office',
      status: 'live',
      turnaround: '7 business days',
      priceFrom: '₦25,000',
      partner: 'WAWU Legal Partners',
      comingNote: null,
    });

    const trademark = res.body.data.find(
      (s: { id: string }) => s.id === SERVICE_TRADEMARK_ID,
    );
    expect(trademark).toMatchObject({
      status: 'coming',
      turnaround: null,
      priceFrom: null,
      partner: null,
      comingNote: 'Launching alongside the next services hub update.',
    });
  });

  it('missing auth -> 401', async () => {
    const res = await request(app.getHttpServer()).get('/api/hub/services');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/hub/services/:id', () => {
  it('valid request -> 200 with contracted PartnerService shape', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/hub/services/${SERVICE_NEPC_ID}`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: SERVICE_NEPC_ID,
      name: 'NEPC Export License',
      status: 'live',
    });
  });

  it('valid uuid but nonexistent service -> 404', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/hub/services/${NONEXISTENT_UUID}`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(404);
    expect(res.body.data).toBeNull();
  });

  it('invalid payload (malformed id) -> 400', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/hub/services/not-a-uuid')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(400);
    expect(res.body.data).toBeNull();
  });

  it('missing auth -> 401', async () => {
    const res = await request(app.getHttpServer()).get(
      `/api/hub/services/${SERVICE_NEPC_ID}`,
    );
    expect(res.status).toBe(401);
  });
});

describe('POST /api/hub/services/:id/notify-me', () => {
  it('valid request -> 200 with {success:true}', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/hub/services/${SERVICE_TRADEMARK_ID}/notify-me`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ success: true });
  });

  it('valid uuid but nonexistent service -> 404', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/hub/services/${NONEXISTENT_UUID}/notify-me`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(404);
    expect(res.body.data).toBeNull();
  });

  it('invalid payload (malformed id) -> 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/hub/services/not-a-uuid/notify-me')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(400);
    expect(res.body.data).toBeNull();
  });

  it('missing auth -> 401', async () => {
    const res = await request(app.getHttpServer()).post(
      `/api/hub/services/${SERVICE_TRADEMARK_ID}/notify-me`,
    );
    expect(res.status).toBe(401);
  });
});
