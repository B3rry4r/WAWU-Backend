import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { DataExportRequestModule } from '../data-export-request.module';

/**
 * Contract tests for DataExportRequest (registry.json § DataExportRequest,
 * one endpoint: POST /settings/privacy/export, roles: "any"). Exercises
 * the module in isolation (per SCOPE — this branch never touches
 * app.module.ts, the dispatcher wires it centrally later) but through a
 * real HTTP stack with the SAME global pipe/filter/interceptor main.ts
 * applies, so the contract exercised here matches production wiring.
 *
 * Auth: real RS256 tokens minted by the mock WAWU ID service (already
 * running on :4001 in this sandbox, conventions.md § Local test
 * environment) for the seeded plain-user wawuUserId
 * 00000000-0000-4000-8000-000000000001 — not a locally-fabricated JWT.
 */

const MOCK_WAWU_ID_BASE_URL = process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';
const SEEDED_USER_EMAIL = 'user@test.wawu.dev';
const SEEDED_USER_SUB = '00000000-0000-4000-8000-000000000001';

async function loginAsSeededUser(): Promise<string> {
  const res = await fetch(`${MOCK_WAWU_ID_BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: SEEDED_USER_EMAIL }),
  });
  if (!res.ok) {
    throw new Error(`mock WAWU ID login failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { accessToken: string };
  return body.accessToken;
}

describe('DataExportRequest contract', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let accessToken: string;
  const createdIds: string[] = [];

  beforeAll(async () => {
    accessToken = await loginAsSeededUser();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        DataExportRequestModule,
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/hub');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();

    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    if (createdIds.length > 0) {
      await prisma.dataExportRequest.deleteMany({ where: { id: { in: createdIds } } });
    }
    await app.close();
  });

  describe('POST /api/hub/settings/privacy/export', () => {
    it('valid request -> 201 with a pending DataExportRequest for the caller', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/hub/settings/privacy/export')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({})
        .expect(201);

      expect(res.body.data).toMatchObject({
        userWawuId: SEEDED_USER_SUB,
        status: 'pending',
      });
      expect(typeof res.body.data.id).toBe('string');
      expect(new Date(res.body.data.requestedAt).toString()).not.toBe('Invalid Date');

      createdIds.push(res.body.data.id);

      const row = await prisma.dataExportRequest.findUnique({ where: { id: res.body.data.id } });
      expect(row).not.toBeNull();
      expect(row?.userWawuId).toBe(SEEDED_USER_SUB);
      expect(row?.status).toBe('pending');
    });

    it('invalid payload (unknown field) -> 400', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/hub/settings/privacy/export')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ notARealField: 'nope' })
        .expect(400);

      expect(res.body.data).toBeNull();
      expect(typeof res.body.message).toBe('string');
    });

    it('missing auth -> 401', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/hub/settings/privacy/export')
        .send({})
        .expect(401);

      expect(res.body.data).toBeNull();
    });
  });
});
