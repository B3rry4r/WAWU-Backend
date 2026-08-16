import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { PlaybookModule } from '../playbook.module';
import type { PlaybookResponse } from '../../common/types';

interface EnvelopeBody<T> {
  statusCode: number;
  message: string;
  data: T;
}

/**
 * Contract tests for registry.json § Playbook — a single endpoint:
 *   GET /api/hub/learn/playbook   roles: ["any"]
 *
 * Auth: real RS256 JWTs from the local mock WAWU ID service (see
 * conventions.md § Local test environment) — not minted/injected tokens.
 * The mock-wawu-id server must be running at WAWU_ID_JWKS_URL /
 * WAWU_ID_BASE_URL (defaults to http://localhost:4001, matching .env).
 *
 * The endpoint takes no request body and no query params, so there is no
 * "invalid payload" shape to exercise — the auth-boundary test covers the
 * only other contracted failure mode (401 with no/garbage token).
 */

const WAWU_ID_BASE_URL =
  process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';
// Seeded plain-user identity (mock-wawu-id/server.js): sub
// 00000000-0000-4000-8000-000000000001 — role is irrelevant here since the
// contract's only role is "any" (any authenticated user).
const SEEDED_USER_IDENTIFIER = 'user@test.wawu.dev';

async function loginAsSeededUser(): Promise<string> {
  const res = await fetch(`${WAWU_ID_BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      identifier: SEEDED_USER_IDENTIFIER,
      password: 'anything',
    }),
  });
  if (!res.ok) {
    throw new Error(
      `mock WAWU ID login failed (${res.status}) — is mock-wawu-id/server.js running at ${WAWU_ID_BASE_URL}?`,
    );
  }
  const body = (await res.json()) as { accessToken: string };
  return body.accessToken;
}

describe('Playbook contract', () => {
  let app: INestApplication;
  let accessToken: string;

  beforeAll(async () => {
    accessToken = await loginAsSeededUser();

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [PrismaModule, WawuAuthModule, PlaybookModule],
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
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/hub/learn/playbook', () => {
    it('returns the seeded Playbook in the contracted shape for an authenticated user', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/hub/learn/playbook')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      const body = res.body as EnvelopeBody<PlaybookResponse>;
      expect(body).toMatchObject({
        statusCode: 200,
        message: 'OK',
      });

      const playbook = body.data;
      expect(playbook).toMatchObject({
        id: expect.any(String),
        title: expect.any(String),
        pages: expect.any(Number),
        format: expect.any(String),
        description: expect.any(String),
      });
      expect(Array.isArray(playbook.chapters)).toBe(true);
      expect(Array.isArray(playbook.readingSections)).toBe(true);
      expect(playbook.chapters.length).toBeGreaterThan(0);
      expect(playbook.readingSections.length).toBeGreaterThan(0);

      // Cross-check against the seeded fixture (prisma/seed.ts PLAYBOOK_MAIN)
      // rather than an invented fixture.
      expect(playbook.title).toBe('The WAWU Creator Playbook');
      expect(playbook.chapters[0]).toMatchObject({
        title: expect.any(String),
        order: expect.any(Number),
      });
      expect(playbook.readingSections[0]).toMatchObject({
        heading: expect.any(String),
        body: expect.any(String),
      });
    });

    it('rejects a request with no bearer token with 401', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/hub/learn/playbook')
        .expect(401);

      expect(res.body).toMatchObject({
        statusCode: 401,
        data: null,
      });
    });

    it('rejects a request with a malformed/garbage bearer token with 401', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/hub/learn/playbook')
        .set('Authorization', 'Bearer not-a-real-jwt')
        .expect(401);

      expect(res.body).toMatchObject({
        statusCode: 401,
        data: null,
      });
    });
  });
});
