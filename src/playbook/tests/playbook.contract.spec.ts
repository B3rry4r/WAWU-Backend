import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AdminAuthModule } from '../../admin/auth/admin-auth.module';
import {
  adminFixtures,
  adminJwtSecrets,
  bearer,
  deleteAdminFixtures,
  loginAllAdmins,
  rolesOtherThan,
  seedAdminFixtures,
  type AdminTokens,
} from '../../common/tests/admin-session.helper';
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
 * The read endpoint takes no request body and no query params, so there is no
 * "invalid payload" shape to exercise — the auth-boundary test covers the
 * only other contracted failure mode (401 with no/garbage token).
 *
 * ── PATCH /learn/playbook IS NEW HERE ────────────────────────────────────
 * The operator write had NO coverage in this file at all while it sat behind
 * AdminKeyGuard — one shared static secret, no identity, no roles — even
 * though it replaces the document every WAWU user downloads. It now sits
 * behind AdminAuthGuard + AdminRolesGuard, `superadmin` only, and the tests
 * below are the first ones it has ever had.
 *
 * Playbook is a SINGLE-ROW resource shared with the seed and with other
 * suites, so this file snapshots the row and puts it back in afterAll
 * (README § Test hygiene rules).
 */

const WAWU_ID_BASE_URL =
  process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';
// Seeded plain-user identity (mock-wawu-id/server.js): sub
// 00000000-0000-4000-8000-000000000001 — role is irrelevant here since the
// contract's only role is "any" (any authenticated user).
const SEEDED_USER_IDENTIFIER = 'user@test.wawu.dev';

const WRITE_ROLES = ['superadmin'] as const;
const ADMINS = adminFixtures('91110000', 'playbook');
const SECRETS = adminJwtSecrets('playbook');
/** Still configured, so "a correct key opens nothing" is what is being proved. */
const RETIRED_KEY = 'playbook-contract-spec-key';

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
  let prisma: PrismaService;
  let accessToken: string;
  let tokens: AdminTokens;
  let seededPlaybook: Awaited<ReturnType<PrismaService['playbook']['findFirst']>>;
  const envSnapshot: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const key of ['ADMIN_JWT_SECRET', 'ADMIN_JWT_REFRESH_SECRET', 'WAWU_ADMIN_KEY']) {
      envSnapshot[key] = process.env[key];
    }
    process.env.ADMIN_JWT_SECRET = SECRETS.access;
    process.env.ADMIN_JWT_REFRESH_SECRET = SECRETS.refresh;
    process.env.WAWU_ADMIN_KEY = RETIRED_KEY;

    accessToken = await loginAsSeededUser();

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        AdminAuthModule,
        PlaybookModule,
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

    prisma = moduleRef.get(PrismaService);
    seededPlaybook = await prisma.playbook.findFirst({ orderBy: { id: 'asc' } });
    await seedAdminFixtures(prisma, ADMINS);
    tokens = await loginAllAdmins(app, ADMINS);
  });

  afterAll(async () => {
    // Single-row resource shared with the seed and other suites — put it back
    // exactly as it was, including the two columns this change now writes.
    if (prisma && seededPlaybook) {
      await prisma.playbook.update({
        where: { id: seededPlaybook.id },
        data: {
          title: seededPlaybook.title,
          description: seededPlaybook.description,
          pages: seededPlaybook.pages,
          format: seededPlaybook.format,
          fileUrl: seededPlaybook.fileUrl,
          updatedAt: seededPlaybook.updatedAt,
          updatedBy: seededPlaybook.updatedBy,
        },
      });
    }
    if (prisma) await deleteAdminFixtures(prisma, ADMINS);
    await app.close();
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  /**
   * The operator write. Never covered here before, and it replaces the
   * document every WAWU user downloads.
   */
  describe('PATCH /api/hub/learn/playbook', () => {
    it('401s with no credential at all', async () => {
      await request(app.getHttpServer())
        .patch('/api/hub/learn/playbook')
        .send({ format: 'PDF' })
        .expect(401);
    });

    it('a WAWU ID user token is not an admin session', async () => {
      await request(app.getHttpServer())
        .patch('/api/hub/learn/playbook')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ format: 'PDF' })
        .expect(401);
    });

    it('the retired x-wawu-admin-key header alone no longer replaces the document', async () => {
      await request(app.getHttpServer())
        .patch('/api/hub/learn/playbook')
        .set('x-wawu-admin-key', RETIRED_KEY)
        .send({ fileUrl: 'https://storage.wawu.test/playbook/held-key.pdf' })
        .expect(401);

      const stored = await prisma.playbook.findFirst({ orderBy: { id: 'asc' } });
      expect(stored?.fileUrl).toBe(seededPlaybook?.fileUrl ?? null);
    });

    it.each(rolesOtherThan(WRITE_ROLES))('%s cannot replace the playbook', async (role) => {
      await request(app.getHttpServer())
        .patch('/api/hub/learn/playbook')
        .set(bearer(tokens[role]))
        .send({ fileUrl: `https://storage.wawu.test/playbook/${role}.pdf` })
        .expect(403);

      const stored = await prisma.playbook.findFirst({ orderBy: { id: 'asc' } });
      expect(stored?.fileUrl).toBe(seededPlaybook?.fileUrl ?? null);
    });

    it('a superadmin can publish it, and is named in the existing updatedBy column', async () => {
      const superadmin = ADMINS.find((a) => a.role === 'superadmin')!;
      const res = await request(app.getHttpServer())
        .patch('/api/hub/learn/playbook')
        .set(bearer(tokens.superadmin))
        .send({ fileUrl: 'https://storage.wawu.test/playbook/published.pdf' })
        .expect(200);

      expect(res.body.data.fileUrl).toBe('https://storage.wawu.test/playbook/published.pdf');
      // `updatedBy` already existed and already shipped as null on the read
      // below, so filling it changes a value, not a shape — no side table and
      // no widened response.
      expect(res.body.data.updatedBy).toBe(superadmin.id);
      // An ID, never an email: this row is handed to every WAWU user.
      expect(JSON.stringify(res.body.data)).not.toContain('@admin.test.wawu.dev');
    });

    it('the GET every user calls sees the published file', async () => {
      await request(app.getHttpServer())
        .patch('/api/hub/learn/playbook')
        .set(bearer(tokens.superadmin))
        .send({ fileUrl: 'https://storage.wawu.test/playbook/visible.pdf' })
        .expect(200);

      const res = await request(app.getHttpServer())
        .get('/api/hub/learn/playbook')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(res.body.data.fileUrl).toBe('https://storage.wawu.test/playbook/visible.pdf');
    });

    it('the read is still a plain user route — moving the guard off the class changed nothing', async () => {
      await request(app.getHttpServer()).get('/api/hub/learn/playbook').expect(401);
      await request(app.getHttpServer())
        .get('/api/hub/learn/playbook')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      // And an ADMIN token is not a user token on the read.
      await request(app.getHttpServer())
        .get('/api/hub/learn/playbook')
        .set(bearer(tokens.superadmin))
        .expect(401);
    });
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
