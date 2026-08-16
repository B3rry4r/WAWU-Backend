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
import { MentorModule } from '../mentor.module';

/**
 * Contract tests for registry.json § Mentor:
 *   GET /services/mentors           (roles: any, optional ?category filter)
 *   GET /services/mentors/:id       (roles: any)
 *
 * Auth: a real RS256 handshake against the local mock WAWU ID service
 * (mock-wawu-id/server.js), matching conventions.md § Local test environment
 * — spawned for the duration of this suite and torn down after. Seeded
 * wawuUserIds/roles per mock-wawu-id/server.js:
 *   ...001 = plain user, ...002 = Basic creator (kyc pending),
 *   ...003 = Pro creator (kyc approved).
 *
 * Mentor fixtures come from prisma/seed.ts (already applied to
 * wawu_hub_test):
 *   40000000-0000-4000-8000-000000000001 "SEEDED: Amara Nwosu" category=fashion
 *   40000000-0000-4000-8000-000000000002 "Tunde Adebayo"       category=technology
 */

const MOCK_WAWU_ID_PORT = 4001;
const MOCK_WAWU_ID_URL = `http://localhost:${MOCK_WAWU_ID_PORT}`;
const MENTOR_AMARA_ID = '40000000-0000-4000-8000-000000000001';
const MENTOR_TUNDE_ID = '40000000-0000-4000-8000-000000000002';
const NONEXISTENT_UUID = '40000000-0000-4000-8000-00000000ffff';

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
    throw new Error(`mock-wawu-id login failed for ${identifier}: ${res.status}`);
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
    imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, WawuAuthModule, MentorModule],
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

describe('GET /api/hub/services/mentors', () => {
  it('valid request -> 200 with contracted Mentor[] shape', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/hub/services/mentors')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.statusCode).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    const ids = res.body.data.map((m: { id: string }) => m.id);
    expect(ids).toEqual(expect.arrayContaining([MENTOR_AMARA_ID, MENTOR_TUNDE_ID]));

    const amara = res.body.data.find((m: { id: string }) => m.id === MENTOR_AMARA_ID);
    expect(amara).toMatchObject({
      name: 'SEEDED: Amara Nwosu',
      handle: 'seeded-amara-nwosu',
      field: 'Fashion & Retail',
      category: 'fashion',
      verification: 'verified_business',
      openForRequests: true,
      fullUntil: null,
      yearsExperience: 12,
      sessions: 87,
      languages: ['English', 'Igbo'],
    });
  });

  it('valid request with ?category filter -> 200, only matching mentors', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/hub/services/mentors')
      .query({ category: 'technology' })
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    const ids = res.body.data.map((m: { id: string }) => m.id);
    expect(ids).toContain(MENTOR_TUNDE_ID);
    expect(ids).not.toContain(MENTOR_AMARA_ID);
    for (const m of res.body.data) {
      expect(m.category).toBe('technology');
    }
  });

  it('missing auth -> 401', async () => {
    const res = await request(app.getHttpServer()).get('/api/hub/services/mentors');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/hub/services/mentors/:id', () => {
  it('valid request -> 200 with contracted Mentor shape', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/hub/services/mentors/${MENTOR_TUNDE_ID}`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: MENTOR_TUNDE_ID,
      name: 'Tunde Adebayo',
      handle: 'tunde-adebayo',
      category: 'technology',
    });
  });

  it('valid uuid but nonexistent mentor -> 404', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/hub/services/mentors/${NONEXISTENT_UUID}`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(404);
    expect(res.body.data).toBeNull();
  });

  it('invalid payload (malformed id) -> 400', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/hub/services/mentors/not-a-uuid')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(400);
    expect(res.body.data).toBeNull();
  });

  it('missing auth -> 401', async () => {
    const res = await request(app.getHttpServer()).get(
      `/api/hub/services/mentors/${MENTOR_TUNDE_ID}`,
    );
    expect(res.status).toBe(401);
  });
});
