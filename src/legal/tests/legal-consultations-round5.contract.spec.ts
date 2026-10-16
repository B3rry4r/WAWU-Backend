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
import { StorageService } from '../../storage/storage.service';

/**
 * LEGAL-03, round 5 (lead rulings after the independent round 3): N1, a
 * delivered file can only be a legal document on our own bucket, and a stored
 * file outside that is never signed; odd paths are a 400 and never stored;
 * T1, the legacy `deliverableUrl` is never handed back unsigned; a `+01`
 * offset on the app's booking is a 400 naming `scheduledFor`.
 */

const MOCK_WAWU_ID_URL =
  process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';
const REPO_ROOT = path.resolve(__dirname, '../../../');
const ADMINS = adminFixtures('1e110006', 'legal-consult-r5');
const SECRETS = adminJwtSecrets('legal-consult-r5');

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

/**
 * FIX-24: a delivered key needs an upload record made by the client or by
 * one of the legal team's accounts (LEGAL_DELIVERY_UPLOADER_IDS). The keys
 * these tests deliver are recorded as uploaded by this legal-team account.
 */
const LEGAL_TEAM_ID = '0000f124-0000-4000-8000-000000000024';
const UPLOADED_KEYS: string[] = [
  'legal/document/u1/11111111-2222-3333-4444-555555555555.pdf',
  'legal/document/u1/notes.pdf',
  'legal/document/u1/ok.pdf',
];

async function recordUploads(prisma: PrismaService): Promise<void> {
  for (const key of UPLOADED_KEYS) {
    await prisma.storageObject.upsert({
      where: { key },
      create: {
        key,
        wawuUserId: LEGAL_TEAM_ID,
        bytes: 1024,
        contentType: 'application/pdf',
        folder: 'legal/document',
      },
      update: { wawuUserId: LEGAL_TEAM_ID },
    });
  }
}

describe('LEGAL-03 fix round 5 (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let storage: StorageService;
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
      'LEGAL_DELIVERY_UPLOADER_IDS',
      'STORAGE_FORCE_PATH_STYLE',
      ...Object.keys(TEST_BUCKET_ENV),
    ]) {
      envSnapshot[key] = process.env[key];
    }
    process.env.LEGAL_DELIVERY_UPLOADER_IDS = LEGAL_TEAM_ID;
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
    await recordUploads(prisma);
    storage = moduleRef.get(StorageService);
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
      await prisma.storageObject.deleteMany({
        where: { key: { in: UPLOADED_KEYS }, wawuUserId: LEGAL_TEAM_ID },
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

  const KYC = (id: string) =>
    `kyc/id-document/${id}/22222222-3333-4444-5555-666666666666.jpg`;
  const KEY = 'legal/document/u1/11111111-2222-3333-4444-555555555555.pdf';

  async function nothingWritten(id: string) {
    expect(
      await prisma.legalDeliverable.count({ where: { legalRequestId: id } }),
    ).toBe(0);
    expect(
      await prisma.legalChatMessage.count({ where: { legalRequestId: id } }),
    ).toBe(0);
    expect(
      await prisma.adminOpsAudit.count({
        where: { resourceId: id, action: 'legal_delivered' },
      }),
    ).toBe(0);
    const row = await prisma.legalRequest.findUniqueOrThrow({
      where: { id },
    });
    expect(row.status).toBe('in_progress');
    expect(row.deliverableUrl).toBeNull();
  }

  /* ================================================================ */
  describe('N1: a delivered file can only be a legal document on our bucket', () => {
    it.each([
      // The verifier's probe, on any host.
      [
        'the KYC key on another host',
        `https://not-the-bucket.example/${KYC('B')}`,
      ],
      ['the KYC key on our bucket', `${BUCKET_ORIGIN}/${KYC('B')}`],
      ['the KYC key, signed', `${BUCKET_ORIGIN}/${KYC('B')}?X-Amz-Signature=x`],
      ['the KYC key, bare', KYC('B')],
      // A key under another prefix.
      ['an avatar', `${BUCKET_ORIGIN}/avatars/u1/a.png`],
      ['a content file, bare', 'content/full/u1/a.pdf'],
      ['a look-alike folder', `${BUCKET_ORIGIN}/legal/documents/u1/a.pdf`],
      ['our key on another host', `https://files.example.com/${KEY}`],
      // Host look-alikes.
      [
        'userinfo',
        `https://wawu-test.storage.test.invalid@evil.example/${KEY}`,
      ],
      [
        'userinfo on our host',
        `https://u:p@wawu-test.storage.test.invalid/${KEY}`,
      ],
      [
        'a subdomain suffix',
        `https://wawu-test.storage.test.invalid.evil.example/${KEY}`,
      ],
      ['a subdomain', `https://x.wawu-test.storage.test.invalid/${KEY}`],
      [
        'our endpoint without the bucket',
        `https://storage.test.invalid/${KEY}`,
      ],
      ['a port', `${BUCKET_ORIGIN}:8443/${KEY}`],
      ['http', `http://wawu-test.storage.test.invalid/${KEY}`],
      ['ftp', `ftp://wawu-test.storage.test.invalid/${KEY}`],
      ['protocol-relative', `//wawu-test.storage.test.invalid/${KEY}`],
      ['javascript', 'javascript:alert(1)'],
      // Path tricks.
      [
        'percent-encoded slashes',
        `${BUCKET_ORIGIN}/legal%2Fdocument%2Fu1%2Fa.pdf`,
      ],
      [
        'an encoded way up',
        `${BUCKET_ORIGIN}/legal/document/%2e%2e/%2e%2e/${KYC('B')}`,
      ],
      ['a way up, bare', `legal/document/../../${KYC('B')}`],
      ['a backslash', `${BUCKET_ORIGIN}/legal/document\\..\\..\\${KYC('B')}`],
      [
        'an encoded backslash',
        `${BUCKET_ORIGIN}/legal/document/%5c..%5c${KYC('B')}`,
      ],
    ])(
      'refuses %s with a 400 naming files.0.url, and stores nothing',
      async (_l, url) => {
        const work = await paidWork();
        const res = await deliver(work.id, {
          files: [{ fileName: 'a.pdf', url }],
        }).expect(400);
        expect(JSON.stringify(res.body)).toContain('files.0.url');
        await nothingWritten(work.id);
      },
    );

    it('names the second file when it is the bad one, and delivers neither', async () => {
      const work = await paidWork();
      const res = await deliver(work.id, {
        files: [
          { fileName: 'ok.pdf', url: `${DOCS}ok.pdf` },
          { fileName: 'id.jpg', url: KYC('B') },
        ],
      }).expect(400);
      expect(JSON.stringify(res.body)).toContain('files.1.url');
      await nothingWritten(work.id);
    });

    it('takes a link on our bucket and a bare key, stores the key, signs it for the client', async () => {
      const work = await paidWork();
      const link = await storage.readUrlFor(KEY);
      const bare = 'legal/document/u1/notes.pdf';
      const res = await deliver(work.id, {
        files: [
          { fileName: 'a.pdf', url: link },
          { fileName: 'notes.pdf', url: bare },
        ],
      }).expect(200);
      const rows = await prisma.legalDeliverable.findMany({
        where: { legalRequestId: work.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(rows.map((r) => r.url)).toEqual([KEY, bare]);
      for (const i of res.body.data.items as { url: string }[]) {
        expect(i.url.startsWith(`${BUCKET_ORIGIN}/legal/document/`)).toBe(true);
        expect(i.url).toContain('X-Amz-Expires=900');
      }
    });

    it.each([
      ['a KYC key', KYC('B')],
      [
        'a KYC link on our bucket',
        `${BUCKET_ORIGIN}/${KYC('B')}?X-Amz-Signature=x`,
      ],
      ['an avatar key', 'avatars/u1/a.png'],
      ['a link on another host', 'https://files.example.com/a.pdf'],
      ['a way up', `legal/document/../../${KYC('B')}`],
      ['a key with a newline', 'legal/document/u1/a\n.pdf'],
      ['a key with an escape', 'legal/document/u1/a%2e.pdf'],
    ])(
      'lists a stored row holding %s by name, and never signs it',
      async (_l, stored) => {
        const work = await paidWork();
        await prisma.legalDeliverable.create({
          data: {
            legalRequestId: work.id,
            wawuUserId: userId,
            fileName: 'stored.pdf',
            url: stored,
          },
        });
        const spy = jest.spyOn(storage, 'signedReadUrl');
        const res = await http()
          .get(`/api/hub/legal/requests/${work.id}/deliverables`)
          .set(as(userToken))
          .expect(200);
        const calls = spy.mock.calls.length;
        spy.mockRestore();
        expect(calls).toBe(0);
        expect(res.body.data.items).toHaveLength(1);
        expect(res.body.data.items[0]).toMatchObject({
          fileName: 'stored.pdf',
          url: null,
        });
      },
    );
  });

  /* ================================================================ */
  describe('odd paths: a 400, never stored, never handed back', () => {
    it.each([
      ['a NUL', `${DOCS}a%00.pdf`],
      ['a lone surrogate', `${DOCS}a%ED%A0%80.pdf`],
      ['invalid UTF-8', `${DOCS}a%FF.pdf`],
      ['a newline', `${DOCS}a%0a.pdf`],
      ['a carriage return', `${DOCS}a%0d.pdf`],
      ['a double-encoded NUL', `${DOCS}a%2500.pdf`],
      ['a raw newline', `${DOCS}a\n.pdf`],
    ])('refuses a url whose path holds %s', async (_l, url) => {
      const work = await paidWork();
      const res = await deliver(work.id, {
        files: [{ fileName: 'a.pdf', url }],
      }).expect(400);
      expect(JSON.stringify(res.body)).toContain('files.0.url');
      await nothingWritten(work.id);
    });
  });

  /* ================================================================ */
  describe('T1: the legacy deliverableUrl is never handed back unsigned', () => {
    it('signs a fresh 15 minute link for a legacy 7-day link on our bucket', async () => {
      const work = await paidWork();
      const legacy = await storage.readUrlFor(KEY);
      expect(legacy).toContain('X-Amz-Expires=604800');
      await prisma.legalRequest.update({
        where: { id: work.id },
        data: {
          status: 'delivered',
          deliverableUrl: legacy,
          deliveredAt: new Date(),
        },
      });
      const res = await http()
        .get(`/api/hub/legal/requests/${work.id}/deliverables`)
        .set(as(userToken))
        .expect(200);
      expect(res.body.data.items).toHaveLength(1);
      const url = res.body.data.items[0].url as string;
      expect(url).not.toBe(legacy);
      expect(url).toContain(KEY);
      expect(url).toContain('X-Amz-Expires=900');
      expect(url).not.toContain('X-Amz-Expires=604800');
    });

    it.each([
      ['a link on another host', 'https://files.example.com/Final.pdf'],
      ['a KYC link on our bucket', `${BUCKET_ORIGIN}/${KYC('B')}`],
    ])('lists a legacy file held as %s with no link', async (_l, legacy) => {
      const work = await paidWork();
      await prisma.legalRequest.update({
        where: { id: work.id },
        data: {
          status: 'delivered',
          deliverableUrl: legacy,
          deliveredAt: new Date(),
        },
      });
      const res = await http()
        .get(`/api/hub/legal/requests/${work.id}/deliverables`)
        .set(as(userToken))
        .expect(200);
      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.items[0].url).toBeNull();
      expect(JSON.stringify(res.body)).not.toContain(legacy);
    });

    it('gives a delivery posted as a bare key a link in the legacy column', async () => {
      const work = await paidWork();
      await deliver(work.id, {
        files: [{ fileName: 'a.pdf', url: KEY }],
      }).expect(200);
      const row = await prisma.legalRequest.findUniqueOrThrow({
        where: { id: work.id },
      });
      expect(row.deliverableUrl).toContain(`${BUCKET_ORIGIN}/${KEY}?`);
    });
  });

  /* ================================================================ */
  describe('a short offset on scheduledFor', () => {
    async function consultRequest() {
      const res = await http()
        .post('/api/hub/legal/requests')
        .set(as(userToken))
        .send({ serviceCode: 'contract-drafting' })
        .expect(201);
      createdIds.push(res.body.data.id);
      return res.body.data as { id: string };
    }

    it.each([
      ['+01', '2099-10-09T10:00:00+01'],
      ['-05', '2099-10-09T10:00:00-05'],
      ['+01 on minutes only', '2099-10-09T10:00+01'],
    ])(
      'refuses %s with a 400 naming scheduledFor',
      async (_l, scheduledFor) => {
        const res = await http()
          .post(
            `/api/hub/legal/requests/${(await consultRequest()).id}/booking`,
          )
          .set(as(userToken))
          .send({ medium: 'zoom', scheduledFor })
          .expect(400);
        expect(JSON.stringify(res.body)).toContain('scheduledFor');
      },
    );
  });
});
