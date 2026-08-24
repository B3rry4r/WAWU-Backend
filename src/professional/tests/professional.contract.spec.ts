// Run against wawu_hub_test — always via `npm run test:contract`.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

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
import { ProfessionalModule } from '../professional.module';

const USER_PLAIN = '00000000-0000-4000-8000-000000000001';
const USER_CREATOR_PRO = '00000000-0000-4000-8000-000000000003';

const MOCK_WAWU_ID_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_WAWU_ID_BASE = `http://localhost:${MOCK_WAWU_ID_PORT}`;

async function waitForHealth(url: string, timeoutMs = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function login(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_WAWU_ID_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) throw new Error(`login failed for ${identifier}: ${res.status}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

/** A valid application body, overridable per test. */
const application = (over: Record<string, unknown> = {}) => ({
  category: 'technology',
  headline: 'Backend engineer, 9 years',
  about:
    'I build and maintain payment integrations for Nigerian fintechs, mostly NestJS and Postgres.',
  services: ['API review', 'Payment integration'],
  credentialKind: 'portfolio',
  ...over,
});

/**
 * Professional profiles.
 *
 * Envelope note: ResponseInterceptor puts a paginated result's rows in `data`
 * and the counts in a sibling `pagination` — not `data.items`.
 */
describe('Professional profiles (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mockWawuId: ChildProcess | undefined;
  let ownedMockWawuId = false;
  let creatorToken: string;
  let plainToken: string;

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
        ProfessionalModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
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
    creatorToken = await login('creator-pro@test.wawu.dev');
    plainToken = await login('user@test.wawu.dev');
  }, 40000);

  beforeEach(async () => {
    await prisma.professionalProfile.deleteMany({
      where: { wawuUserId: { in: [USER_PLAIN, USER_CREATOR_PRO] } },
    });
  });

  afterAll(async () => {
    await prisma.professionalProfile.deleteMany({
      where: { wawuUserId: { in: [USER_PLAIN, USER_CREATOR_PRO] } },
    });
    await app?.close();
    if (ownedMockWawuId && mockWawuId) mockWawuId.kill();
  }, 30000);

  const post = (token: string, body: object) =>
    request(app.getHttpServer())
      .post('/professionals/applications')
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  // ---- applying ----------------------------------------------------------

  it('a creator can apply, and the application starts pending', async () => {
    const res = await post(creatorToken, application()).expect(201);
    expect(res.body.data.status).toBe('pending');
    expect(res.body.data.category).toBe('technology');
  });

  it('a buyer account cannot apply', async () => {
    // Being listed is a way to get paid, and payment is a creator activity.
    // Approving a buyer would put them in a directory they cannot transact
    // from.
    await post(plainToken, application()).expect(403);
  });

  it('401s without a token', async () => {
    await request(app.getHttpServer())
      .post('/professionals/applications')
      .send(application())
      .expect(401);
  });

  // ---- the regulated-category rule ---------------------------------------

  it('refuses a portfolio in a regulated field', async () => {
    const res = await post(
      creatorToken,
      application({ category: 'legal_services', credentialKind: 'portfolio' }),
    ).expect(400);
    expect(res.body.message).toMatch(/regulated/i);
  });

  it('refuses a regulated application with no licence number', async () => {
    await post(
      creatorToken,
      application({
        category: 'healthcare',
        credentialKind: 'licence',
        issuingBody: 'MDCN',
      }),
    ).expect(400);
  });

  it('refuses a regulated application with no issuing body', async () => {
    // Without a body to ring, "confirm the licence" is not a job a reviewer
    // can do, so the row could only ever be rejected.
    await post(
      creatorToken,
      application({
        category: 'healthcare',
        credentialKind: 'licence',
        licenceNumber: 'MDCN/2019/44821',
      }),
    ).expect(400);
  });

  it('accepts a regulated application with a licence and an issuing body', async () => {
    const res = await post(
      creatorToken,
      application({
        category: 'legal_services',
        credentialKind: 'licence',
        licenceNumber: 'SCN/2014/10233',
        issuingBody: 'Nigerian Bar Association',
      }),
    ).expect(201);
    expect(res.body.data.status).toBe('pending');
  });

  it('accepts a portfolio outside a regulated field', async () => {
    await post(creatorToken, application({ category: 'technology' })).expect(
      201,
    );
  });

  it('rejects a category that is not in the taxonomy', async () => {
    await post(creatorToken, application({ category: 'wizardry' })).expect(400);
  });

  // ---- one per category --------------------------------------------------

  it('refuses a second application while one is under review', async () => {
    await post(creatorToken, application()).expect(201);
    await post(creatorToken, application()).expect(409);
  });

  it('replaces a REJECTED application in place rather than duplicating it', async () => {
    await post(creatorToken, application()).expect(201);
    await prisma.professionalProfile.updateMany({
      where: { wawuUserId: USER_CREATOR_PRO, category: 'technology' },
      data: { status: 'rejected', rejectionReason: 'Documents unreadable' },
    });

    await post(
      creatorToken,
      application({ headline: 'Backend engineer, 10 years' }),
    ).expect(201);

    const rows = await prisma.professionalProfile.findMany({
      where: { wawuUserId: USER_CREATOR_PRO, category: 'technology' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending');
    // The old reason must not survive onto a fresh application — it would
    // show a rejected banner on something nobody has looked at yet.
    expect(rows[0].rejectionReason).toBeNull();
  });

  it('lets the same creator apply in a DIFFERENT category', async () => {
    await post(creatorToken, application({ category: 'technology' })).expect(
      201,
    );
    await post(creatorToken, application({ category: 'education' })).expect(
      201,
    );

    const mine = await request(app.getHttpServer())
      .get('/professionals/applications/mine')
      .set('Authorization', `Bearer ${creatorToken}`)
      .expect(200);
    expect(mine.body.data).toHaveLength(2);
  });

  // ---- the directory -----------------------------------------------------

  it('does NOT list a pending application', async () => {
    await post(creatorToken, application()).expect(201);

    const res = await request(app.getHttpServer())
      .get('/professionals')
      .query({ category: 'technology' })
      .expect(200);
    const ids = res.body.data.map((p: { wawuId: string }) => p.wawuId);
    expect(ids).not.toContain(USER_CREATOR_PRO);
  });

  it('lists an approved one, publicly, with real identity and contact terms', async () => {
    await post(creatorToken, application()).expect(201);
    await prisma.professionalProfile.updateMany({
      where: { wawuUserId: USER_CREATOR_PRO, category: 'technology' },
      data: { status: 'approved', reviewedAt: new Date() },
    });

    // No Authorization header: someone looking for help should not have to
    // sign up to see that WAWU has anyone.
    const res = await request(app.getHttpServer())
      .get('/professionals')
      .query({ category: 'technology' })
      .expect(200);

    const listed = res.body.data.find(
      (p: { wawuId: string }) => p.wawuId === USER_CREATOR_PRO,
    );
    expect(listed).toBeDefined();
    expect(listed.name).toBe('Zainab Bello');
    expect(listed.headline).toBe('Backend engineer, 9 years');
    // The contact terms are part of the card: a professional you cannot
    // message is not a lead.
    expect(listed).toHaveProperty('dmEnabled');
    expect(listed).toHaveProperty('dmPrice');
    expect(listed).toHaveProperty('dmResponseHours');
  });

  it('hides an approved listing the professional has unlisted', async () => {
    await post(creatorToken, application()).expect(201);
    const row = await prisma.professionalProfile.findFirstOrThrow({
      where: { wawuUserId: USER_CREATOR_PRO, category: 'technology' },
    });
    await prisma.professionalProfile.update({
      where: { id: row.id },
      data: { status: 'approved', reviewedAt: new Date() },
    });

    await request(app.getHttpServer())
      .patch(`/professionals/applications/${row.id}/listing`)
      .set('Authorization', `Bearer ${creatorToken}`)
      .send({ listed: false })
      .expect(200);

    const res = await request(app.getHttpServer())
      .get('/professionals')
      .query({ category: 'technology' })
      .expect(200);
    const ids = res.body.data.map((p: { wawuId: string }) => p.wawuId);
    expect(ids).not.toContain(USER_CREATOR_PRO);
  });

  it('never publishes the licence NUMBER, only who issued it', async () => {
    // A buyer is entitled to know who certified someone so they can check the
    // register. The number itself is an identifier that can be used to
    // impersonate them.
    await post(
      creatorToken,
      application({
        category: 'legal_services',
        credentialKind: 'licence',
        licenceNumber: 'SCN/2014/10233',
        issuingBody: 'Nigerian Bar Association',
      }),
    ).expect(201);
    const row = await prisma.professionalProfile.findFirstOrThrow({
      where: { wawuUserId: USER_CREATOR_PRO, category: 'legal_services' },
    });
    await prisma.professionalProfile.update({
      where: { id: row.id },
      data: { status: 'approved', reviewedAt: new Date() },
    });

    const res = await request(app.getHttpServer())
      .get(`/professionals/${row.id}`)
      .expect(200);

    expect(res.body.data.issuingBody).toBe('Nigerian Bar Association');
    expect(JSON.stringify(res.body)).not.toContain('SCN/2014/10233');
  });

  it("someone else cannot hide another person's listing", async () => {
    await post(creatorToken, application()).expect(201);
    const row = await prisma.professionalProfile.findFirstOrThrow({
      where: { wawuUserId: USER_CREATOR_PRO },
    });
    await prisma.professionalProfile.update({
      where: { id: row.id },
      data: { status: 'approved', reviewedAt: new Date() },
    });

    await request(app.getHttpServer())
      .patch(`/professionals/applications/${row.id}/listing`)
      .set('Authorization', `Bearer ${plainToken}`)
      .send({ listed: false })
      .expect(403);
  });

  it('an admin decision response carries no licence number', async () => {
    // Declaring a narrow return type does NOT narrow the object: prisma
    // resolves the full row and TypeScript accepts a wider one where a
    // narrower is declared, so the column would ship regardless. This asserts
    // the runtime shape, which is the only thing a buyer's browser sees.
    await post(
      creatorToken,
      application({
        category: 'legal_services',
        credentialKind: 'licence',
        licenceNumber: 'SCN/2014/99999',
        issuingBody: 'Nigerian Bar Association',
      }),
    ).expect(201);

    const row = await prisma.professionalProfile.findFirstOrThrow({
      where: { wawuUserId: USER_CREATOR_PRO, category: 'legal_services' },
    });
    await prisma.professionalProfile.update({
      where: { id: row.id },
      data: { status: 'approved', reviewedAt: new Date() },
    });

    const res = await request(app.getHttpServer())
      .get(`/professionals/${row.id}`)
      .expect(200);
    expect(JSON.stringify(res.body)).not.toContain('SCN/2014/99999');
    expect(res.body.data.licenceNumber).toBeUndefined();
  });

});
