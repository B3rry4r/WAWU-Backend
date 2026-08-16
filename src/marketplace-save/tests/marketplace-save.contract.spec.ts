// Force the test DB before anything else touches PrismaService (conventions.md
// § ORM / database — this backend's own logic must run against wawu_hub_test,
// never wawu_hub_dev, even if the process env wasn't already overridden by the
// invoking `npm test` command).
process.env.DATABASE_URL =
  process.env.DATABASE_URL?.includes('wawu_hub_test')
    ? process.env.DATABASE_URL
    : 'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
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
import { MarketplaceSaveModule } from '../marketplace-save.module';

/**
 * Seeded WAWU ID test users (mock-wawu-id/server.js, mirrored by
 * prisma/seed.ts). `MarketplaceSave` roles are "any" — any authenticated
 * user is enough, so we exercise the plain user + basic creator only.
 */
const USER_PLAIN_EMAIL = 'user@test.wawu.dev';
const USER_PLAIN_SUB = '00000000-0000-4000-8000-000000000001';
const USER_CREATOR_BASIC_EMAIL = 'creator-basic@test.wawu.dev';

// A per-process port for this spec file's own instance of the mock WAWU ID
// service — avoids colliding with sibling resource agents' contract tests
// running the same mock concurrently on the shared sandbox (each Jest
// worker process has a distinct pid).
const MOCK_WAWU_ID_PORT = 45000 + (process.pid % 4000);
const MOCK_WAWU_ID_URL = `http://127.0.0.1:${MOCK_WAWU_ID_PORT}`;

const TEST_TAG = `contract-test-${process.pid}`;
const NEW_SAVE_PRODUCT_ID = `${TEST_TAG}-new-save`;
const EXISTING_SAVE_PRODUCT_ID = `${TEST_TAG}-existing-save`;
const NOT_FOUND_PRODUCT_ID = `${TEST_TAG}-never-saved`;

let mockWawuId: ChildProcessWithoutNullStreams;
let app: INestApplication;
let prisma: PrismaService;
let plainUserToken: string;
let creatorBasicToken: string;

async function waitForMockWawuId(): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${MOCK_WAWU_ID_URL}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('mock-wawu-id did not become healthy in time');
}

async function loginAs(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_WAWU_ID_URL}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) {
    throw new Error(`mock-wawu-id login failed for ${identifier}: ${res.status}`);
  }
  const body = (await res.json()) as { accessToken: string };
  return body.accessToken;
}

beforeAll(async () => {
  // 1. Boot a private instance of the mock WAWU ID service (real Express
  // process, real RS256 signing, real JWKS endpoint) so WawuAuthGuard does
  // a genuine HTTP JWKS handshake rather than a minted/injected token.
  mockWawuId = spawn('node', [path.join(__dirname, '../../../mock-wawu-id/server.js')], {
    env: { ...process.env, MOCK_WAWU_ID_PORT: String(MOCK_WAWU_ID_PORT) },
    stdio: 'pipe',
  });
  await waitForMockWawuId();

  // Point this test's WawuJwtStrategy at our private mock instance instead
  // of whatever WAWU_ID_JWKS_URL the shared .env carries (dotenv never
  // overrides an already-set process.env value, so this wins).
  process.env.WAWU_ID_JWKS_URL = `${MOCK_WAWU_ID_URL}/.well-known/jwks.json`;

  [plainUserToken, creatorBasicToken] = await Promise.all([
    loginAs(USER_PLAIN_EMAIL),
    loginAs(USER_CREATOR_BASIC_EMAIL),
  ]);

  // 2. Build a real Nest app wired the same way main.ts wires it (global
  // pipe/filter/interceptor), scoped to just the modules this resource
  // needs.
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true }),
      PrismaModule,
      WawuAuthModule,
      MarketplaceSaveModule,
    ],
  }).compile();

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/hub');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new ResponseInterceptor());
  await app.init();

  prisma = moduleRef.get(PrismaService);

  // 3. Fixture for the DELETE-valid-path test: guarantee this row exists
  // regardless of the shared test DB's current seed/reset state.
  await prisma.marketplaceSave.upsert({
    where: {
      userWawuId_productId_shop: {
        userWawuId: USER_PLAIN_SUB,
        productId: EXISTING_SAVE_PRODUCT_ID,
        shop: 'basket',
      },
    },
    update: {},
    create: { userWawuId: USER_PLAIN_SUB, productId: EXISTING_SAVE_PRODUCT_ID, shop: 'basket' },
  });
}, 30_000);

afterAll(async () => {
  await prisma?.marketplaceSave.deleteMany({
    where: { productId: { in: [NEW_SAVE_PRODUCT_ID, EXISTING_SAVE_PRODUCT_ID, NOT_FOUND_PRODUCT_ID] } },
  });
  await app?.close();
  mockWawuId?.kill();
});

describe('POST /api/hub/marketplace/saves', () => {
  it('valid request -> 201 with the MarketplaceSave shape', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/hub/marketplace/saves')
      .set('Authorization', `Bearer ${creatorBasicToken}`)
      .send({ productId: NEW_SAVE_PRODUCT_ID, shop: 'beauty' })
      .expect(201);

    expect(res.body).toMatchObject({
      statusCode: 200,
      message: 'OK',
      data: {
        userWawuId: '00000000-0000-4000-8000-000000000002',
        productId: NEW_SAVE_PRODUCT_ID,
        shop: 'beauty',
      },
    });
    expect(res.body.data.id).toEqual(expect.any(String));
    expect(res.body.data.savedAt).toEqual(expect.any(String));
  });

  it('invalid payload (bad shop enum value) -> 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/hub/marketplace/saves')
      .set('Authorization', `Bearer ${creatorBasicToken}`)
      .send({ productId: NEW_SAVE_PRODUCT_ID, shop: 'not-a-real-shop' })
      .expect(400);

    expect(res.body.statusCode).toBe(400);
    expect(res.body.data).toBeNull();
  });

  it('missing auth -> 401', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/hub/marketplace/saves')
      .send({ productId: NEW_SAVE_PRODUCT_ID, shop: 'basket' })
      .expect(401);

    expect(res.body.statusCode).toBe(401);
  });
});

describe('DELETE /api/hub/marketplace/saves/:productId', () => {
  it('valid request against an existing save -> 200, void data', async () => {
    const res = await request(app.getHttpServer())
      .delete(`/api/hub/marketplace/saves/${EXISTING_SAVE_PRODUCT_ID}`)
      .set('Authorization', `Bearer ${plainUserToken}`)
      .expect(200);

    expect(res.body).toEqual({ statusCode: 200, message: 'OK', data: null });

    const stillThere = await prisma.marketplaceSave.findFirst({
      where: { userWawuId: USER_PLAIN_SUB, productId: EXISTING_SAVE_PRODUCT_ID },
    });
    expect(stillThere).toBeNull();
  });

  // No request body exists on this endpoint to exercise class-validator's
  // 400 path, so the endpoint's other real negative path — deleting a save
  // that was never made — stands in as the "invalid input" case.
  it('deleting a productId with no matching save -> 404', async () => {
    const res = await request(app.getHttpServer())
      .delete(`/api/hub/marketplace/saves/${NOT_FOUND_PRODUCT_ID}`)
      .set('Authorization', `Bearer ${plainUserToken}`)
      .expect(404);

    expect(res.body.statusCode).toBe(404);
    expect(res.body.data).toBeNull();
  });

  it('missing auth -> 401', async () => {
    const res = await request(app.getHttpServer())
      .delete(`/api/hub/marketplace/saves/${EXISTING_SAVE_PRODUCT_ID}`)
      .expect(401);

    expect(res.body.statusCode).toBe(401);
  });
});
