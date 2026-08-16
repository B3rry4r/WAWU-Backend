import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import request from 'supertest';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { DmReportModule } from '../dm-report.module';

/**
 * Contract tests for registry.json § DmReport — POST /dm/:messageId/report
 * is the resource's ONLY endpoint.
 *
 * Auth handshake: per conventions.md § Local test environment, this spins
 * up (or reuses, if another concurrently-running Phase 5 agent already has)
 * the real mock-wawu-id service and performs a real HTTP login against it,
 * so tokens are genuinely RS256-signed and verified over JWKS by
 * WawuJwtStrategy — never minted/injected directly into the request.
 *
 * Fixture data: the frozen contract's only dependency is DirectMessage
 * (the `threadId` a report attaches to). No DirectMessage rows are part of
 * prisma/seed.ts (that resource is out of this wave's scope), so this file
 * creates its own minimal DirectMessage fixture rows directly via Prisma —
 * standard practice for satisfying a foreign key this resource doesn't own,
 * not a build of the DirectMessage resource itself.
 */

const MOCK_WAWU_ID_URL = process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';
const REPO_ROOT = path.resolve(__dirname, '../../../');

const USER_PLAIN = '00000000-0000-4000-8000-000000000001'; // plain user
const USER_CREATOR_BASIC = '00000000-0000-4000-8000-000000000002'; // Basic creator, KYC pending
const USER_CREATOR_PRO = '00000000-0000-4000-8000-000000000003'; // Pro creator, KYC approved

async function isMockWawuIdUp(): Promise<boolean> {
  try {
    const res = await fetch(`${MOCK_WAWU_ID_URL}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForMockWawuId(timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isMockWawuIdUp()) return;
    await new Promise((r) => setTimeout(r, 250));
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

describe('DmReport contract', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mockWawuIdProcess: ChildProcess | undefined;

  let tokenPlain: string;
  let tokenCreatorBasic: string;
  let tokenCreatorPro: string;

  let threadA: string; // fresh thread, reported by USER_PLAIN in the happy-path test
  let threadB: string; // fresh thread, used for the duplicate-report / 409 case

  beforeAll(async () => {
    if (!(await isMockWawuIdUp())) {
      mockWawuIdProcess = spawn('node', ['mock-wawu-id/server.js'], {
        cwd: REPO_ROOT,
        stdio: 'ignore',
        detached: true,
      });
      // Detached + unref: if another concurrently-running Phase 5 agent's
      // test run is still using this shared local service after this
      // process exits, it survives rather than being torn down underneath
      // them.
      mockWawuIdProcess.unref();
      await waitForMockWawuId();
    }

    [tokenPlain, tokenCreatorBasic, tokenCreatorPro] = await Promise.all([
      loginAs('user@test.wawu.dev'),
      loginAs('creator-basic@test.wawu.dev'),
      loginAs('creator-pro@test.wawu.dev'),
    ]);

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, WawuAuthModule, DmReportModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/hub');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();

    prisma = moduleRef.get(PrismaService);

    const [a, b] = await Promise.all([
      prisma.directMessage.create({
        data: {
          creatorWawuId: USER_CREATOR_BASIC,
          senderWawuId: USER_PLAIN,
          text: 'DmReport contract test fixture thread A',
          amount: 200,
          deadlineAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          flutterwaveTxRef: `dmreport-test-fixture-a-${Date.now()}`,
        },
        select: { id: true },
      }),
      prisma.directMessage.create({
        data: {
          creatorWawuId: USER_CREATOR_PRO,
          senderWawuId: USER_PLAIN,
          text: 'DmReport contract test fixture thread B',
          amount: 300,
          deadlineAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          flutterwaveTxRef: `dmreport-test-fixture-b-${Date.now()}`,
        },
        select: { id: true },
      }),
    ]);
    threadA = a.id;
    threadB = b.id;
  }, 30_000);

  afterAll(async () => {
    if (prisma) {
      // DmReport rows cascade-delete with their thread (onDelete: Cascade),
      // so deleting the fixture DirectMessage rows is sufficient cleanup.
      await prisma.directMessage.deleteMany({ where: { id: { in: [threadA, threadB] } } });
    }
    if (app) await app.close();
    // Deliberately NOT killing mockWawuIdProcess (see beforeAll comment) —
    // it's a shared local dependency other concurrently-running agents'
    // test suites may still be using.
  });

  describe('POST /dm/:messageId/report', () => {
    it('valid request -> 201 with the created DmReport shape', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/hub/dm/${threadA}/report`)
        .set('Authorization', `Bearer ${tokenPlain}`)
        .send({});

      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        id: expect.any(String),
        threadId: threadA,
        reporterWawuId: USER_PLAIN,
      });
      expect(typeof res.body.data.createdAt).toBe('string');
    });

    it('a second report of the same thread by the same reporter -> 409 (unique constraint)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/hub/dm/${threadB}/report`)
        .set('Authorization', `Bearer ${tokenCreatorPro}`)
        .send({});
      expect(res.status).toBe(201);

      const dupe = await request(app.getHttpServer())
        .post(`/api/hub/dm/${threadB}/report`)
        .set('Authorization', `Bearer ${tokenCreatorPro}`)
        .send({});
      expect(dupe.status).toBe(409);
      expect(dupe.body.data).toBeNull();
    });

    it('reporting a non-existent thread -> 404', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/hub/dm/00000000-0000-4000-8000-000000009999/report')
        .set('Authorization', `Bearer ${tokenCreatorBasic}`)
        .send({});
      expect(res.status).toBe(404);
    });

    it('invalid payload (non-UUID :messageId path param) -> 400', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/hub/dm/not-a-valid-uuid/report')
        .set('Authorization', `Bearer ${tokenPlain}`)
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.data).toBeNull();
    });

    it('invalid payload (stray body field, forbidNonWhitelisted) -> 400', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/hub/dm/${threadA}/report`)
        .set('Authorization', `Bearer ${tokenCreatorBasic}`)
        .send({ reason: 'spam' });
      expect(res.status).toBe(400);
      expect(res.body.data).toBeNull();
    });

    it('missing auth -> 401', async () => {
      const res = await request(app.getHttpServer()).post(`/api/hub/dm/${threadA}/report`).send({});
      expect(res.status).toBe(401);
    });

    it('malformed/invalid token -> 401', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/hub/dm/${threadA}/report`)
        .set('Authorization', 'Bearer not-a-real-token')
        .send({});
      expect(res.status).toBe(401);
    });
  });
});
