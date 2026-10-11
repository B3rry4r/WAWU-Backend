process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../../app.module';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';

/**
 * INBOX-05's two literal routes, `GET /communities/suggested` and
 * `GET /communities/message-cost`, share their first segment with
 * CommunityController's `GET /communities/:id`, which answers 400 "uuid is
 * expected" to anything else. Only the composed app can show which one wins,
 * so this boots the full AppModule (the same reason
 * src/common/tests/route-shadowing.regression.spec.ts does) and asks each
 * literal path for its own answer. `GET /communities/:id/room` is two
 * segments and cannot be taken by `:id`; it is checked here too.
 */
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

describe('INBOX-05 routes in the full app (contract)', () => {
  let app: INestApplication;
  let token: string;
  let mockWawuId: ChildProcess | undefined;
  const server = (): App => app.getHttpServer() as App;

  beforeAll(async () => {
    if (!(await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`, 1000))) {
      mockWawuId = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '../../../mock-wawu-id'),
        env: { ...process.env, MOCK_WAWU_ID_PORT },
        stdio: 'ignore',
      });
      if (!(await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`))) {
        throw new Error('mock-wawu-id did not become healthy in time');
      }
    }
    const login = await fetch(`${MOCK_WAWU_ID_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: 'user@test.wawu.dev' }),
    });
    if (!login.ok)
      throw new Error(`mock-wawu-id login failed: ${login.status}`);
    token = ((await login.json()) as { accessToken: string }).accessToken;

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
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
  }, 60000);

  afterAll(async () => {
    await app?.close();
    mockWawuId?.kill();
  });

  it('GET /communities/suggested reaches its own handler, not /communities/:id', async () => {
    const res = await request(server())
      .get('/api/hub/communities/suggested?page=1&perPage=5')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const body = res.body as {
      data: unknown[];
      pagination: { currentPage: number; perPage: number };
    };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.pagination).toMatchObject({ currentPage: 1, perPage: 5 });
  });

  it('GET /communities/message-cost reaches its own handler, not /communities/:id', async () => {
    const res = await request(server())
      .get('/api/hub/communities/message-cost')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const data = (res.body as { data: { creditsPerMessage: number } }).data;
    expect(typeof data.creditsPerMessage).toBe('number');
  });

  it('GET /communities/:id/room answers 404 for an unknown room, and :id still answers 400 for a non-uuid', async () => {
    await request(server())
      .get('/api/hub/communities/c3000000-0000-4000-8000-00000000dead/room')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
    await request(server())
      .get('/api/hub/communities/not-a-room')
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
  });
});
