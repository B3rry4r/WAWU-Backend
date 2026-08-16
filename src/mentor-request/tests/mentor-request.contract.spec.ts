import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { MentorRequestModule } from '../mentor-request.module';

/**
 * Contract tests for registry.json § MentorRequest:
 *   POST /services/mentors/:id/requests   (roles: any)
 *
 * FREE — mentors volunteer their time, no payment step (registry note /
 * schema comment on the Prisma model).
 *
 * Auth: a real RS256 handshake against the local mock WAWU ID service
 * (mock-wawu-id/server.js), matching conventions.md § Local test environment
 * — spawned for the duration of this suite and torn down after. Seeded
 * wawuUserIds/roles per mock-wawu-id/server.js:
 *   ...001 = plain user, ...002 = Basic creator (kyc pending),
 *   ...003 = Pro creator (kyc approved).
 *
 * Mentor fixture comes from prisma/seed.ts (already applied to
 * wawu_hub_test):
 *   40000000-0000-4000-8000-000000000001 "SEEDED: Amara Nwosu" category=fashion
 */

const MOCK_WAWU_ID_PORT = 4001;
const MOCK_WAWU_ID_URL = `http://localhost:${MOCK_WAWU_ID_PORT}`;
const MENTOR_AMARA_ID = '40000000-0000-4000-8000-000000000001';
const NONEXISTENT_MENTOR_ID = '40000000-0000-4000-8000-00000000ffff';
const USER_PLAIN = '00000000-0000-4000-8000-000000000001';

let mockWawuId: ChildProcess | undefined;
let app: INestApplication;
let prisma: PrismaService;
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
    imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, WawuAuthModule, MentorRequestModule],
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
}, 30000);

afterAll(async () => {
  await app?.close();
  mockWawuId?.kill();
});

describe('POST /api/hub/services/mentors/:id/requests', () => {
  it('valid request -> 201 with contracted MentorRequest shape', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/hub/services/mentors/${MENTOR_AMARA_ID}/requests`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        topics: ['inventory', 'hiring'],
        note: 'Would love guidance on scaling from one store to three.',
        slot: '2026-08-20T10:00:00.000Z',
      });

    expect([200, 201]).toContain(res.status);
    expect(res.body.data).toMatchObject({
      mentorId: MENTOR_AMARA_ID,
      requesterWawuId: USER_PLAIN,
      topics: ['inventory', 'hiring'],
      note: 'Would love guidance on scaling from one store to three.',
      slot: '2026-08-20T10:00:00.000Z',
      status: 'pending',
    });
    expect(res.body.data.id).toEqual(expect.any(String));

    const stored = await prisma.mentorRequest.findUnique({ where: { id: res.body.data.id } });
    expect(stored).not.toBeNull();
    expect(stored?.requesterWawuId).toBe(USER_PLAIN);
  });

  it('nonexistent mentor -> 404', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/hub/services/mentors/${NONEXISTENT_MENTOR_ID}/requests`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        topics: ['fundraising'],
        note: 'Looking for advice on seed funding.',
        slot: '2026-08-21T10:00:00.000Z',
      });

    expect(res.status).toBe(404);
    expect(res.body.data).toBeNull();
  });

  it('malformed mentor id -> 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/hub/services/mentors/not-a-uuid/requests')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        topics: ['fundraising'],
        note: 'Looking for advice on seed funding.',
        slot: '2026-08-21T10:00:00.000Z',
      });

    expect(res.status).toBe(400);
    expect(res.body.data).toBeNull();
  });

  it('invalid payload (empty topics) -> 400', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/hub/services/mentors/${MENTOR_AMARA_ID}/requests`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ topics: [], note: 'Some note here.', slot: '2026-08-22T10:00:00.000Z' });

    expect(res.status).toBe(400);
    expect(res.body.data).toBeNull();
  });

  it('invalid payload (missing note) -> 400', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/hub/services/mentors/${MENTOR_AMARA_ID}/requests`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ topics: ['hiring'], slot: '2026-08-22T10:00:00.000Z' });

    expect(res.status).toBe(400);
    expect(res.body.data).toBeNull();
  });

  it('invalid payload (non-whitelisted field) -> 400', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/hub/services/mentors/${MENTOR_AMARA_ID}/requests`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        topics: ['hiring'],
        note: 'Some note here.',
        slot: '2026-08-22T10:00:00.000Z',
        priceNaira: 5000,
      });

    expect(res.status).toBe(400);
    expect(res.body.data).toBeNull();
  });

  it('missing auth -> 401', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/hub/services/mentors/${MENTOR_AMARA_ID}/requests`)
      .send({ topics: ['hiring'], note: 'Some note here.', slot: '2026-08-22T10:00:00.000Z' });

    expect(res.status).toBe(401);
  });
});
