// Run against wawu_hub_test — see README "Running the tests"; always via
// `npm run test:contract`, never bare jest.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

process.env.STORAGE_ENDPOINT = 'https://bucket.example-storage.dev';
process.env.STORAGE_ACCESS_KEY_ID = 'tid_test';
process.env.STORAGE_SECRET_ACCESS_KEY = 'secret_test';
process.env.STORAGE_BUCKET = 'test-bucket';
process.env.STORAGE_REGION = 'auto';

import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ConfigModule } from '@nestjs/config';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreatorDiscoveryModule } from '../creator-discovery.module';

const USER_CREATOR_PRO = '00000000-0000-4000-8000-000000000003';

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

/**
 * GET /creators — the endpoint whose absence made the consumer app invent
 * people.
 *
 * Envelope note: ResponseInterceptor puts a paginated result's rows directly
 * in `data` and the counts in a sibling `pagination` — NOT `data.items`. Its whole job is to return REAL accounts, so the assertions are
 * about identity being real and resolved, not merely about a 200.
 */
describe('CreatorDiscovery avatar (HUB-IMG-LINKS)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mockWawuId: ChildProcess | undefined;
  let ownedMockWawuId = false;
  let before: string | null = null;
  const OLD = `https://bucket.example-storage.dev/test-bucket/avatars/${USER_CREATOR_PRO}/a.png?X-Amz-Expires=604800&X-Amz-Signature=expired`;

  beforeAll(async () => {
    if (!(await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`, 1500))) {
      mockWawuId = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '../../../mock-wawu-id'),
        env: { ...process.env, MOCK_WAWU_ID_PORT },
        stdio: 'ignore',
      });
      ownedMockWawuId = true;
      await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`);
    }
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        CreatorDiscoveryModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();
    prisma = moduleRef.get(PrismaService);
    before =
      (
        await prisma.userProfile.findUnique({
          where: { wawuUserId: USER_CREATOR_PRO },
          select: { avatarUrl: true },
        })
      )?.avatarUrl ?? null;
  }, 40000);

  afterAll(async () => {
    await prisma?.userProfile.update({
      where: { wawuUserId: USER_CREATOR_PRO },
      data: { avatarUrl: before },
    });
    await app?.close();
    if (ownedMockWawuId && mockWawuId) mockWawuId.kill();
  }, 30000);

  const avatarOf = async (): Promise<string> => {
    const res = await request(app.getHttpServer())
      .get('/creators')
      .query({ perPage: 50 })
      .expect(200);
    const me = (
      res.body as { data: { wawuId: string; avatarUrl: string | null }[] }
    ).data.find((c) => c.wawuId === USER_CREATOR_PRO);
    return me?.avatarUrl as string;
  };

  it('a creator suggestion signs the stored avatar again, so it opens after 8 days, and keeps the same link inside a day', async () => {
    await prisma.userProfile.update({
      where: { wawuUserId: USER_CREATOR_PRO },
      data: { avatarUrl: OLD },
    });
    const first = await avatarOf();
    expect(first).toContain(`/avatars/${USER_CREATOR_PRO}/a.png?`);
    expect(first).not.toContain('Signature=expired');
    const q = new URL(first).searchParams;
    expect(q.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(q.get('response-cache-control')).toBe(
      'private, max-age=31536000, immutable',
    );
    // Signed at the start of the UTC day, valid for more than the 8 days the stale link failed at is not possible
    // (7 days is the most a link can live), so it is signed again on every day instead.
    expect(q.get('X-Amz-Date')).toMatch(/^\d{8}T000000Z$/);
    expect(await avatarOf()).toBe(first);
  });
});
