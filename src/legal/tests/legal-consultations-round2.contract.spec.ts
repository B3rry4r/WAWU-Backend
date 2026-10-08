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
import { AdminAuthModule } from '../../admin/auth/admin-auth.module';
import {
  adminFixtures,
  adminJwtSecrets,
  bearer,
  deleteAdminFixtures,
  loginAllAdmins,
  seedAdminFixtures,
  type AdminTokens,
} from '../../common/tests/admin-session.helper';
import { LegalModule } from '../legal.module';
import { LegalIntakeModule } from '../../legal-intake/legal-intake.module';
import { LegalAssistantAllowance } from '../../legal-intake/assistant/legal-assistant-allowance';

/**
 * LEGAL-03, fix round 1 (verifier D1 to D4): a delivered url that cannot be
 * stored is a 400, a delivery is one whole step with its audit row, the web's
 * booking and the app's booking take the same lock, and a delivery writes the
 * consultant's chat line under the client's lock.
 */

const MOCK_WAWU_ID_URL =
  process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';
const REPO_ROOT = path.resolve(__dirname, '../../../');
const ADMINS = adminFixtures('1e110004', 'legal-consult-r2');
const SECRETS = adminJwtSecrets('legal-consult-r2');

async function isMockUp(): Promise<boolean> {
  try {
    return (await fetch(`${MOCK_WAWU_ID_URL}/health`)).ok;
  } catch {
    return false;
  }
}

async function loginAs(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_WAWU_ID_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) throw new Error(`login failed for ${identifier}: ${res.status}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

const subOf = (token: string): string =>
  JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8')).sub;

/**
 * Round 5 (N1): an offline bucket for the delivery tests. The SDK signs
 * virtual-hosted links on `https://<bucket>.<endpoint host>/<key>`.
 */
const TEST_BUCKET_ENV = {
  STORAGE_ENDPOINT: 'https://storage.test.invalid',
  STORAGE_BUCKET: 'wawu-test',
  STORAGE_ACCESS_KEY_ID: 'test-key',
  STORAGE_SECRET_ACCESS_KEY: 'test-secret',
  STORAGE_REGION: 'auto',
};
const BUCKET_ORIGIN = 'https://wawu-test.storage.test.invalid';
/** Where a delivered legal document lives on that bucket. */
const DOCS = `${BUCKET_ORIGIN}/legal/document/u1/`;

describe('LEGAL-03 fix round 1 (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let allowance: LegalAssistantAllowance;
  let mock: ChildProcess | undefined;
  let tokens: AdminTokens;
  let userToken: string;
  let otherToken: string;
  let userId: string;
  let otherId: string;
  const envSnapshot: Record<string, string | undefined> = {};
  let optionRows: Awaited<
    ReturnType<PrismaService['legalConsultationOption']['findMany']>
  >;
  let createdIds: string[] = [];

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    for (const key of [
      'ADMIN_JWT_SECRET',
      'ADMIN_JWT_REFRESH_SECRET',
      'STORAGE_FORCE_PATH_STYLE',
      ...Object.keys(TEST_BUCKET_ENV),
    ]) {
      envSnapshot[key] = process.env[key];
    }
    process.env.ADMIN_JWT_SECRET = SECRETS.access;
    process.env.ADMIN_JWT_REFRESH_SECRET = SECRETS.refresh;
    // Round 5 (N1): a delivered file must be a legal document on our own
    // bucket, so the suite runs with one configured. Links are signed
    // locally; nothing is sent to it.
    delete process.env.STORAGE_FORCE_PATH_STYLE;
    Object.assign(process.env, TEST_BUCKET_ENV);
    if (!(await isMockUp())) {
      mock = spawn('node', ['mock-wawu-id/server.js'], {
        cwd: REPO_ROOT,
        stdio: 'ignore',
        detached: true,
      });
      mock.unref();
      for (let i = 0; i < 60 && !(await isMockUp()); i++) {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    userToken = await loginAs('user@test.wawu.dev');
    otherToken = await loginAs('creator-basic@test.wawu.dev');
    userId = subOf(userToken);
    otherId = subOf(otherToken);

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        AdminAuthModule,
        LegalModule,
        LegalIntakeModule,
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
    allowance = moduleRef.get(LegalAssistantAllowance);
    optionRows = await prisma.legalConsultationOption.findMany();
    await seedAdminFixtures(prisma, ADMINS);
    tokens = await loginAllAdmins(app, ADMINS);
  }, 40_000);

  afterEach(async () => {
    if (createdIds.length) {
      await prisma.legalDeliverable.deleteMany({
        where: { legalRequestId: { in: createdIds } },
      });
      await prisma.legalChatMessage.deleteMany({
        where: { legalRequestId: { in: createdIds } },
      });
      await prisma.adminOpsAudit.deleteMany({
        where: { resourceId: { in: createdIds } },
      });
      await prisma.legalRequest.deleteMany({
        where: { id: { in: createdIds } },
      });
      createdIds = [];
    }
    await prisma.notification.deleteMany({
      where: { userWawuId: { in: [userId, otherId] }, kind: 'legal_delivered' },
    });
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.legalConsultationOption.deleteMany({});
      for (const r of optionRows) {
        await prisma.legalConsultationOption.create({ data: r });
      }
      await prisma.adminOpsAudit.deleteMany({
        where: {
          resource: 'legal_price',
          actedByAdminId: { in: ADMINS.map((a) => a.id) },
        },
      });
      await deleteAdminFixtures(prisma, ADMINS);
    }
    if (app) await app.close();
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function paidWork(wawuUserId = userId) {
    const row = await prisma.legalRequest.create({
      data: {
        wawuUserId,
        serviceCode: 'contract-review',
        serviceName: 'Contract review',
        category: 'Contracts',
        path: 'consultation',
        status: 'in_progress',
        servicePaidAt: new Date(),
      },
    });
    createdIds.push(row.id);
    return row;
  }

  const deliver = (id: string, body: unknown) =>
    http()
      .post(`/api/hub/legal/ops/requests/${id}/deliverables`)
      .set(bearer(tokens.support))
      .send(body as object);

  /* ================================================================ */
  describe('D1, D2: a url that cannot be stored is a 400', () => {
    it.each([
      ['a NUL', `${DOCS}\u0000`],
      ['a NUL early', `${DOCS}a\u0000b.pdf`],
      ['a newline', `${DOCS}a\nb.pdf`],
      ['a tab', `${DOCS}a\tb.pdf`],
      ['a lone high surrogate', `${DOCS}\ud800`],
      ['a lone low surrogate', `${DOCS}\udc00x`],
      ['a reversed pair', `${DOCS}\udc00\ud800`],
    ])(
      'refuses a url with %s, naming the field, and posts nothing',
      async (_l, url) => {
        const work = await paidWork();
        const res = await deliver(work.id, {
          files: [{ fileName: 'a.pdf', url }],
        }).expect(400);
        expect(JSON.stringify(res.body)).toContain('url');
        expect(
          await prisma.legalChatMessage.count({
            where: { legalRequestId: work.id },
          }),
        ).toBe(0);
        expect(
          await prisma.legalDeliverable.count({
            where: { legalRequestId: work.id },
          }),
        ).toBe(0);
        expect(
          (await prisma.legalRequest.findUnique({ where: { id: work.id } }))
            ?.status,
        ).toBe('in_progress');
        expect(
          await prisma.notification.count({
            where: { userWawuId: userId, kind: 'legal_delivered' },
          }),
        ).toBe(0);
      },
    );

    it('refuses the bad url when it is the second file, and delivers none', async () => {
      const work = await paidWork();
      await deliver(work.id, {
        files: [
          { fileName: 'ok.pdf', url: `${DOCS}ok.pdf` },
          { fileName: 'bad.pdf', url: `${DOCS}\u0000` },
        ],
      }).expect(400);
      expect(
        await prisma.legalChatMessage.count({
          where: { legalRequestId: work.id },
        }),
      ).toBe(0);
    });

    // Round 3 (D2) stores the key, not the link; round 5 (N1) takes only a
    // link on our own bucket under legal/document/, whose key needs no escape.
    it('stores a good url as its key, with the audit row naming the same key', async () => {
      const work = await paidWork();
      const url = `${DOCS}files/cafe.pdf?v=1&b=2`;
      const key = url.slice(`${BUCKET_ORIGIN}/`.length, url.indexOf('?'));
      await deliver(work.id, { files: [{ fileName: 'a.pdf', url }] }).expect(
        200,
      );
      const row = await prisma.legalDeliverable.findFirstOrThrow({
        where: { legalRequestId: work.id },
      });
      expect(row.url).toBe(key);
      const audit = await prisma.adminOpsAudit.findFirst({
        where: { resourceId: work.id, action: 'legal_delivered' },
      });
      expect(audit?.detail).toEqual({
        fileCount: 1,
        files: [{ fileName: 'a.pdf', url: key }],
      });
    });

    it('writes the audit row in the same step: a delivery with no audit row cannot happen', async () => {
      // The audit insert is part of the delivery's own transaction, so when it
      // is refused by the database the files, the chat lines and the status
      // change are undone and the client is not told.
      const work = await paidWork();
      const spy = jest
        .spyOn(allowance, 'writeAsConsultant')
        .mockImplementationOnce((client, write) =>
          prisma.$transaction(async (tx) => {
            const real = tx.adminOpsAudit.create.bind(tx.adminOpsAudit);
            (tx.adminOpsAudit as { create: unknown }).create = () =>
              real({ data: null as never });
            return write(tx, new Date());
          }),
        );
      const res = await deliver(work.id, {
        files: [{ fileName: 'a.pdf', url: `${DOCS}a.pdf` }],
      });
      spy.mockRestore();
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(
        await prisma.legalChatMessage.count({
          where: { legalRequestId: work.id },
        }),
      ).toBe(0);
      expect(
        await prisma.legalDeliverable.count({
          where: { legalRequestId: work.id },
        }),
      ).toBe(0);
      expect(
        (await prisma.legalRequest.findUnique({ where: { id: work.id } }))
          ?.status,
      ).toBe('in_progress');
      expect(
        await prisma.notification.count({
          where: { userWawuId: userId, kind: 'legal_delivered' },
        }),
      ).toBe(0);
    });
  });

  /* ================================================================ */
  describe('D4: a delivery writes through the allowance lock', () => {
    it('goes through writeAsConsultant for the client, and keeps two ordered chat lines', async () => {
      const work = await paidWork();
      const spy = jest.spyOn(allowance, 'writeAsConsultant');
      await deliver(work.id, {
        files: [
          { fileName: 'One.pdf', url: `${DOCS}1.pdf` },
          { fileName: 'Two.pdf', url: `${DOCS}2.pdf` },
        ],
      }).expect(200);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toBe(userId);
      spy.mockRestore();
      const lines = await prisma.legalChatMessage.findMany({
        where: { legalRequestId: work.id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      expect(lines.map((l) => [l.authorRole, l.body])).toEqual([
        ['consultant', 'One.pdf'],
        ['consultant', 'Two.pdf'],
      ]);
      expect(lines[1].createdAt.getTime()).toBeGreaterThan(
        lines[0].createdAt.getTime(),
      );
    });

    it('waits for the client message in flight, which holds the client lock', async () => {
      const work = await paidWork();
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let locked!: () => void;
      const gotLock = new Promise<void>((r) => (locked = r));
      const holder = prisma.$transaction(
        async (tx) => {
          await allowance.lockPerson(tx, userId);
          locked();
          await held;
        },
        { timeout: 20_000 },
      );
      await gotLock;
      let done = false;
      const delivery = deliver(work.id, {
        files: [{ fileName: 'a.pdf', url: `${DOCS}a.pdf` }],
      }).then((r) => {
        done = true;
        return r;
      });
      await new Promise((r) => setTimeout(r, 700));
      expect(done).toBe(false);
      expect(
        await prisma.legalChatMessage.count({
          where: { legalRequestId: work.id },
        }),
      ).toBe(0);
      release();
      await holder;
      expect((await delivery).status).toBe(200);
      expect(
        await prisma.legalChatMessage.count({
          where: { legalRequestId: work.id },
        }),
      ).toBe(1);
    });
  });

  /* ================================================================ */
  describe('D3: the web and the app book under one lock', () => {
    async function setZoom(minutes: number) {
      await http()
        .put('/api/hub/legal/ops/prices/consultations/zoom')
        .set(bearer(tokens.finance))
        .send({ priceKobo: 1_500_000, minutes })
        .expect(200);
    }

    async function consultRequest(token: string) {
      const res = await http()
        .post('/api/hub/legal/requests')
        .set(as(token))
        .send({ serviceCode: 'contract-drafting' })
        .expect(201);
      createdIds.push(res.body.data.id);
      return res.body.data.id as string;
    }

    async function calendar() {
      const res = await http()
        .get('/api/hub/legal/consultation/slots')
        .query({ medium: 'zoom' })
        .set(as(userToken))
        .expect(200);
      return res.body.data.days as {
        slots: { startsAt: string }[];
      }[];
    }

    const app_ = (token: string, id: string, scheduledFor: string) =>
      http()
        .post(`/api/hub/legal/requests/${id}/booking`)
        .set(as(token))
        .send({ medium: 'zoom', scheduledFor });
    const web_ = (token: string, id: string, scheduledFor: string) =>
      http()
        .post(`/api/hub/legal/requests/${id}/consultation`)
        .set(as(token))
        .send({ medium: 'zoom', scheduledFor });

    const ROUNDS = 12;

    it.each([
      ['app against web', app_, web_],
      ['web against app', web_, app_],
      ['web against web', web_, web_],
      ['app against app', app_, app_],
    ])(
      'lets exactly one of two overlapping 90 minute calls have the time: %s',
      async (_label, first, second) => {
        await setZoom(90);
        const days = await calendar();
        for (
          let round = 0;
          round < Math.min(ROUNDS, days.length - 2);
          round++
        ) {
          // Two different starts that overlap (09:00 and 10:00 of a 90 minute call).
          const day = days[1 + round];
          const a = day.slots[0].startsAt;
          const b = day.slots[1].startsAt;
          const [one, two] = await Promise.all([
            consultRequest(userToken),
            consultRequest(otherToken),
          ]);
          const results = await Promise.all([
            first(userToken, one, a),
            second(otherToken, two, b),
          ]);
          expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
        }
      },
      120_000,
    );

    it('still lets two calls that do not overlap both have their time, on either route', async () => {
      await setZoom(90);
      const days = await calendar();
      const [one, two] = await Promise.all([
        consultRequest(userToken),
        consultRequest(otherToken),
      ]);
      const results = await Promise.all([
        app_(userToken, one, days[days.length - 1].slots[0].startsAt),
        web_(otherToken, two, days[days.length - 1].slots[3].startsAt),
      ]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
    });
  });
});
