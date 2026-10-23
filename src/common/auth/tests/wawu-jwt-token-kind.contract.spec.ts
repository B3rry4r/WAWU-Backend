process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import * as jwt from 'jsonwebtoken';
import request from 'supertest';
import type { App } from 'supertest/types';
import { ensureKeyPair } from '../../../../test/nuvion/wawu-id-double';
import { AppModule } from '../../../app.module';
import { AllExceptionsFilter } from '../../filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../interceptors/response.interceptor';

/**
 * FIX-99 (H3): the Hub takes only a WAWU ID ACCESS token as a session. WAWU ID
 * signs its refresh tokens (30 days) with the same key and the same JWKS and
 * marks them `type: 'refresh'`; an access token carries no `type`. Before this
 * task the Hub checked the signature and the expiry only, so a refresh token
 * answered 200 on every user route.
 *
 * The full app, a real database and the stand-in WAWU ID (it signs a refresh
 * token the way the real one does: `{ sub, type: 'refresh' }`). The three
 * routes the re-walk found open: GET /users/me, GET /money/wallet, GET /chats.
 */
const MOCK_WAWU_ID_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_WAWU_ID_BASE = `http://localhost:${MOCK_WAWU_ID_PORT}`;
const KID = 'mock-wawu-id-key-1';

const ROUTES = ['/api/hub/users/me', '/api/hub/money/wallet', '/api/hub/chats'];

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

describe('FIX-99: only an access token is a Hub session (contract)', () => {
  let app: INestApplication;
  let mockWawuId: ChildProcess | undefined;
  let accessToken: string;
  let refreshToken: string;
  let claims: Record<string, unknown>;
  let privateKey: string;
  const server = (): App => app.getHttpServer() as App;

  const get = (route: string, token: string) =>
    request(server()).get(route).set('Authorization', `Bearer ${token}`);

  /** The login's own access claims, signed again with one extra claim. */
  const signWith = (extra: Record<string, unknown>): string =>
    jwt.sign({ ...claims, ...extra }, privateKey, {
      algorithm: 'RS256',
      keyid: KID,
      expiresIn: '15m',
    });

  beforeAll(async () => {
    privateKey = ensureKeyPair().privateKey;
    if (!(await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`, 1000))) {
      mockWawuId = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '../../../../mock-wawu-id'),
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
    const pair = (await login.json()) as {
      accessToken: string;
      refreshToken: string;
    };
    accessToken = pair.accessToken;
    refreshToken = pair.refreshToken;
    claims = { ...(jwt.decode(accessToken) as Record<string, unknown>) };
    delete claims.iat;
    delete claims.exp;

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

  it('the stand-in marks its refresh token the way WAWU ID does, and its access token carries no type', () => {
    expect(jwt.decode(refreshToken)).toMatchObject({ type: 'refresh' });
    expect(jwt.decode(accessToken)).not.toHaveProperty('type');
  });

  it.each(ROUTES)('an access token passes on %s', async (route) => {
    await get(route, accessToken).expect(200);
  });

  it.each(ROUTES)(
    'a refresh token is refused on %s with the usual 401',
    async (route) => {
      const refused = await get(route, refreshToken).expect(401);
      const garbage = await get(route, 'not.a.token').expect(401);
      expect(refused.body).toEqual(garbage.body);
    },
  );

  it('a refresh token that carries a full set of identity claims is refused too', async () => {
    const dressed = signWith({ type: 'refresh', jti: 'a-jti' });
    for (const route of ROUTES) await get(route, dressed).expect(401);
  });

  it('a token of any other type is refused', async () => {
    const other = signWith({ type: 'activation' });
    for (const route of ROUTES) await get(route, other).expect(401);
  });

  it('a token that says it is an access token passes', async () => {
    const named = signWith({ type: 'access' });
    for (const route of ROUTES) await get(route, named).expect(200);
  });

  it('a route that signs in only if it can treats a refresh token as nobody, never as the person', async () => {
    // GET /search takes an optional bearer: a refresh token gives the anonymous answer.
    const anon = await request(server()).get('/api/hub/search?q=a').expect(200);
    const withRefresh = await get('/api/hub/search?q=a', refreshToken).expect(
      200,
    );
    expect(withRefresh.body).toEqual(anon.body);
  });
});
