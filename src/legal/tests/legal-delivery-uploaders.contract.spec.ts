import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
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
import { LegalDeliveryRule } from '../legal-delivery-rule';
import { LegalDeliverySettings } from '../legal-delivery-settings';

/**
 * FIX-24 (lead ruling, 8 Oct 2026): a delivered legal document can only be
 * the client's own file or one the legal team uploaded.
 *
 * The reproduction is the LEGAL-03 post-merge verifier's N2 (`h/n1.mjs`, last
 * block): client B uploads a document to `legal/document` and files it with
 * a matter of their own, so support sees its key in the ops queue; support
 * then delivers it on client A's paid request, through the new route and
 * through the older single-file route, as a presigned link and as a bare
 * key; and a key nobody uploaded. Each must be refused with a 400 naming the
 * field, store nothing, and hand nobody a link. Rows written by hand that
 * name B's file are never signed for A.
 */

const MOCK_WAWU_ID_URL =
  process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';
const REPO_ROOT = path.resolve(__dirname, '../../../');
const ADMINS = adminFixtures('1e110024', 'legal-delivery-uploaders');
const SECRETS = adminJwtSecrets('legal-delivery-uploaders');

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
  (
    JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8')) as {
      sub: string;
    }
  ).sub;

/** One file in a list of delivered files, as the API answers it. */
interface ListedFile {
  id: string;
  fileName: string;
  url: string | null;
}
const dataOf = <T>(res: request.Response): T => (res.body as { data: T }).data;
const itemsOf = (res: request.Response): ListedFile[] =>
  dataOf<{ items: ListedFile[] }>(res).items;

/** An offline bucket: links are signed locally and nothing is sent to it. */
const TEST_BUCKET_ENV = {
  STORAGE_ENDPOINT: 'https://storage.test.invalid',
  STORAGE_BUCKET: 'wawu-test',
  STORAGE_ACCESS_KEY_ID: 'test-key',
  STORAGE_SECRET_ACCESS_KEY: 'test-secret',
  STORAGE_REGION: 'auto',
};
const BUCKET_ORIGIN = 'https://wawu-test.storage.test.invalid';

const REFUSAL =
  'must be a document the legal team uploaded to WAWU storage, or one the client uploaded themselves.';

interface Upload {
  key: string;
  fileUrl: string;
}

describe('FIX-24: a delivered legal document is the client own file or the legal team upload (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let storage: StorageService;
  let rule: LegalDeliveryRule;
  let mock: ChildProcess | undefined;
  let tokens: AdminTokens;
  /** A: the client whose paid request is delivered. */
  let aToken: string;
  let aId: string;
  /** B: another client, whose own attachment must never reach A. */
  let bToken: string;
  let bId: string;
  /** C: a legal-team account, listed in LEGAL_DELIVERY_UPLOADER_IDS. */
  let cToken: string;
  let cId: string;
  const envSnapshot: Record<string, string | undefined> = {};
  let createdIds: string[] = [];
  const uploadedKeys: string[] = [];

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    for (const key of [
      'ADMIN_JWT_SECRET',
      'ADMIN_JWT_REFRESH_SECRET',
      'STORAGE_FORCE_PATH_STYLE',
      'LEGAL_DELIVERY_UPLOADER_IDS',
      ...Object.keys(TEST_BUCKET_ENV),
    ]) {
      envSnapshot[key] = process.env[key];
    }
    process.env.ADMIN_JWT_SECRET = SECRETS.access;
    process.env.ADMIN_JWT_REFRESH_SECRET = SECRETS.refresh;
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
    aToken = await loginAs('user@test.wawu.dev');
    bToken = await loginAs('creator-basic@test.wawu.dev');
    cToken = await loginAs('creator-pro@test.wawu.dev');
    aId = subOf(aToken);
    bId = subOf(bToken);
    cId = subOf(cToken);
    // The legal team's account, written in capitals with spaces around it:
    // ids are compared without case, and spaces around a comma are ignored.
    process.env.LEGAL_DELIVERY_UPLOADER_IDS = ` ${cId.toUpperCase()} `;

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
    storage = moduleRef.get(StorageService);
    rule = moduleRef.get(LegalDeliveryRule);
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
      where: {
        userWawuId: { in: [aId, bId, cId] },
        kind: 'legal_delivered',
      },
    });
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.storageObject.deleteMany({
        where: { key: { in: uploadedKeys } },
      });
      await deleteAdminFixtures(prisma, ADMINS);
    }
    if (app) await app.close();
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (mock?.pid) {
      try {
        process.kill(-mock.pid);
      } catch {
        // already gone
      }
    }
  });

  /** A presigns a legal document through the real route, as the app does. */
  async function upload(token: string): Promise<Upload> {
    const res = await http()
      .post('/api/hub/uploads/presign')
      .set(as(token))
      .send({
        folder: 'legal/document',
        contentType: 'application/pdf',
        extension: 'pdf',
        contentLength: 132,
      })
      .expect(200);
    const data = dataOf<Upload>(res);
    uploadedKeys.push(data.key);
    return data;
  }

  async function paidWork(wawuUserId: string) {
    const row = await prisma.legalRequest.create({
      data: {
        wawuUserId,
        serviceCode: 'contract-drafting',
        serviceName: 'Contract drafting',
        category: 'Contracts',
        path: 'consultation',
        status: 'in_progress',
        servicePaidAt: new Date(),
      },
    });
    createdIds.push(row.id);
    return row;
  }

  const deliverFiles = (id: string, body: unknown) =>
    http()
      .post(`/api/hub/legal/ops/requests/${id}/deliverables`)
      .set(bearer(tokens.support))
      .send(body as object);

  const deliverOne = (
    id: string,
    deliverableUrl: string,
    role: 'superadmin' | 'support' = 'superadmin',
  ) =>
    http()
      .post(`/api/hub/legal/ops/requests/${id}/deliver`)
      .set(bearer(tokens[role]))
      .send({ deliverableUrl });

  const listFor = (token: string, id: string) =>
    http().get(`/api/hub/legal/requests/${id}/deliverables`).set(as(token));

  /** Nothing about the delivery was written, and the request did not move. */
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
    expect(row.deliveredAt).toBeNull();
  }

  /** B's own matter, carrying B's attachment: what support sees in its queue. */
  async function bFilesAMatter(): Promise<Upload> {
    const bDoc = await upload(bToken);
    const filed = await http()
      .post('/api/hub/legal/requests')
      .set(as(bToken))
      .send({ serviceCode: 'contract-review', documents: [bDoc.fileUrl] })
      .expect(201);
    createdIds.push(dataOf<{ id: string }>(filed).id);
    const queue = await http()
      .get('/api/hub/legal/ops/requests')
      .set(bearer(tokens.support))
      .expect(200);
    // The precondition of the attack: support can read B's key.
    expect(JSON.stringify(queue.body)).toContain(bDoc.key);
    return bDoc;
  }

  /* ================================================================ */
  describe("N2: another client's document is refused on both write routes", () => {
    it.each([
      ['as the presigned link', (d: Upload) => d.fileUrl],
      ['as a bare key', (d: Upload) => d.key],
      [
        'as an unsigned link on our bucket',
        (d: Upload) => `${BUCKET_ORIGIN}/${d.key}`,
      ],
    ])(
      "refuses B's document %s on A's request: 400 files.0.url, nothing stored, no link",
      async (_l, form) => {
        const bDoc = await bFilesAMatter();
        const work = await paidWork(aId);
        const res = await deliverFiles(work.id, {
          files: [{ fileName: 'Agreement.pdf', url: form(bDoc) }],
        }).expect(400);
        const text = JSON.stringify(res.body);
        expect(text).toContain(`files.0.url ${REFUSAL}`);
        expect(text).not.toContain(bDoc.key);
        expect(text).not.toContain('X-Amz');
        expect(text).not.toContain('—');
        await nothingWritten(work.id);
        const list = await listFor(aToken, work.id).expect(200);
        expect(itemsOf(list)).toEqual([]);
      },
    );

    it("names files.1.url when B's document follows A's own, and delivers neither", async () => {
      const bDoc = await bFilesAMatter();
      const aDoc = await upload(aToken);
      const work = await paidWork(aId);
      const res = await deliverFiles(work.id, {
        files: [
          { fileName: 'Mine.pdf', url: aDoc.fileUrl },
          { fileName: 'Agreement.pdf', url: bDoc.fileUrl },
        ],
      }).expect(400);
      expect(JSON.stringify(res.body)).toContain(`files.1.url ${REFUSAL}`);
      await nothingWritten(work.id);
    });

    it.each(['superadmin', 'support'] as const)(
      "refuses B's document on the older single-file route for %s: 400 deliverableUrl, nothing stored",
      async (role) => {
        const bDoc = await bFilesAMatter();
        const work = await paidWork(aId);
        for (const url of [bDoc.fileUrl, `${BUCKET_ORIGIN}/${bDoc.key}`]) {
          const res = await deliverOne(work.id, url, role).expect(400);
          const text = JSON.stringify(res.body);
          expect(text).toContain(`deliverableUrl ${REFUSAL}`);
          expect(text).not.toContain(bDoc.key);
          expect(text).not.toContain('X-Amz');
        }
        await nothingWritten(work.id);
        const list = await listFor(aToken, work.id).expect(200);
        expect(itemsOf(list)).toEqual([]);
      },
    );

    it('refuses a key nobody uploaded, on both routes', async () => {
      const work = await paidWork(aId);
      const ghost = `legal/document/${crypto.randomUUID()}/${crypto.randomUUID()}.pdf`;
      for (const url of [ghost, `${BUCKET_ORIGIN}/${ghost}`]) {
        const res = await deliverFiles(work.id, {
          files: [{ fileName: 'Ghost.pdf', url }],
        }).expect(400);
        expect(JSON.stringify(res.body)).toContain(`files.0.url ${REFUSAL}`);
      }
      const old = await deliverOne(work.id, `${BUCKET_ORIGIN}/${ghost}`).expect(
        400,
      );
      expect(JSON.stringify(old.body)).toContain(`deliverableUrl ${REFUSAL}`);
      await nothingWritten(work.id);
    });

    it("refuses B's document on a host under our storage, and a KYC key, on the older route", async () => {
      const bDoc = await bFilesAMatter();
      const work = await paidWork(aId);
      for (const url of [
        `https://x.wawu-test.storage.test.invalid/${bDoc.key}`,
        `https://storage.test.invalid/wawu-test/${bDoc.key}`,
        `https://WAWU-TEST.storage.test.invalid./${bDoc.key}`,
        `${BUCKET_ORIGIN}/kyc/id-document/${bId}/22222222-3333-4444-5555-666666666666.jpg`,
      ]) {
        await deliverOne(work.id, url).expect(400);
      }
      await nothingWritten(work.id);
    });

    it('still takes a link on another host on the older route, as the protected lock holds, and never signs it', async () => {
      const work = await paidWork(aId);
      const elsewhere = 'https://cdn.wawu.test/deliverable.pdf';
      const res = await deliverOne(work.id, elsewhere).expect(200);
      expect(dataOf<{ deliverableUrl: string }>(res).deliverableUrl).toBe(
        elsewhere,
      );
      const list = await listFor(aToken, work.id).expect(200);
      expect(itemsOf(list)).toHaveLength(1);
      expect(itemsOf(list)[0].url).toBeNull();
    });
  });

  /* ================================================================ */
  describe('reads: a stored file that fails the rule is never signed', () => {
    it("lists rows written by hand that name B's document by name only, and signs nothing", async () => {
      const bDoc = await bFilesAMatter();
      const work = await paidWork(aId);
      const ghost = `legal/document/${crypto.randomUUID()}/${crypto.randomUUID()}.pdf`;
      for (const [i, url] of [
        bDoc.key,
        bDoc.fileUrl,
        `${BUCKET_ORIGIN}/${bDoc.key}`,
        ghost,
      ].entries()) {
        await prisma.legalDeliverable.create({
          data: {
            legalRequestId: work.id,
            wawuUserId: aId,
            fileName: `hand-${i}.pdf`,
            url,
          },
        });
      }
      const spy = jest.spyOn(storage, 'signedReadUrl');
      const res = await listFor(aToken, work.id).expect(200);
      const signed = spy.mock.calls.length;
      spy.mockRestore();
      expect(signed).toBe(0);
      expect(itemsOf(res)).toHaveLength(4);
      for (const item of itemsOf(res)) {
        expect(item.url).toBeNull();
      }
      expect(JSON.stringify(res.body)).not.toContain(bDoc.key);
      expect(JSON.stringify(res.body)).not.toContain('X-Amz');
    });

    it("lists a legacy deliverableUrl holding B's link with no link", async () => {
      const bDoc = await bFilesAMatter();
      const work = await paidWork(aId);
      // What the older route wrote before this task, for a link on our bucket.
      await prisma.legalRequest.update({
        where: { id: work.id },
        data: {
          status: 'delivered',
          deliverableUrl: bDoc.fileUrl,
          deliveredAt: new Date(),
        },
      });
      const spy = jest.spyOn(storage, 'signedReadUrl');
      const res = await listFor(aToken, work.id).expect(200);
      const signed = spy.mock.calls.length;
      spy.mockRestore();
      expect(signed).toBe(0);
      expect(itemsOf(res)).toHaveLength(1);
      expect(itemsOf(res)[0].url).toBeNull();
      expect(JSON.stringify(res.body)).not.toContain(bDoc.key);
    });

    it('logs a withheld file once, at warn level, naming no key or link', async () => {
      const bDoc = await bFilesAMatter();
      const work = await paidWork(aId);
      const row = await prisma.legalDeliverable.create({
        data: {
          legalRequestId: work.id,
          wawuUserId: aId,
          fileName: 'hand.pdf',
          url: bDoc.key,
        },
      });
      const warn = jest.spyOn(Logger.prototype, 'warn');
      await listFor(aToken, work.id).expect(200);
      await listFor(aToken, work.id).expect(200);
      const lines = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes(row.id));
      warn.mockRestore();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(work.id);
      expect(lines[0]).toContain(
        'uploaded by neither the client nor the legal team',
      );
      expect(lines[0]).not.toContain(bDoc.key);
      expect(lines[0]).not.toContain('—');
    });
  });

  /* ================================================================ */
  describe("allowed: the client's own file, and the legal team's", () => {
    it("delivers A's own upload back to A, stores the key and signs it for A", async () => {
      const aDoc = await upload(aToken);
      const work = await paidWork(aId);
      await deliverFiles(work.id, {
        files: [{ fileName: 'Your draft.pdf', url: aDoc.fileUrl }],
      }).expect(200);
      const rows = await prisma.legalDeliverable.findMany({
        where: { legalRequestId: work.id },
      });
      expect(rows.map((r) => r.url)).toEqual([aDoc.key]);
      const list = await listFor(aToken, work.id).expect(200);
      const url = itemsOf(list)[0].url as string;
      expect(url.startsWith(`${BUCKET_ORIGIN}/${aDoc.key}?`)).toBe(true);
      expect(url).toContain('X-Amz-Expires=900');
    });

    it('delivers a legal-team upload on both routes, and signs each for the client', async () => {
      const first = await upload(cToken);
      const second = await upload(cToken);
      const work = await paidWork(aId);
      await deliverOne(work.id, first.fileUrl, 'support').expect(200);
      await deliverFiles(work.id, {
        files: [{ fileName: 'Notes.pdf', url: second.key }],
      }).expect(200);
      const list = await listFor(aToken, work.id).expect(200);
      expect(
        itemsOf(list).map((i) => new URL(i.url as string).pathname),
      ).toEqual([`/${first.key}`, `/${second.key}`]);
      for (const i of itemsOf(list)) {
        expect(i.url).toContain('X-Amz-Expires=900');
      }
      // B cannot read them.
      await listFor(bToken, work.id).expect(404);
    });

    it("refuses A's own upload on B's request", async () => {
      const aDoc = await upload(aToken);
      const work = await paidWork(bId);
      await deliverFiles(work.id, {
        files: [{ fileName: 'a.pdf', url: aDoc.key }],
      }).expect(400);
      await nothingWritten(work.id);
    });

    it('refuses a legal-team upload when the setting does not list that account', async () => {
      const cDoc = await upload(cToken);
      const at = await storage.bucketLocation();
      const unlisted = new LegalDeliveryRule(
        prisma,
        storage,
        app.get(ConfigService),
        new LegalDeliverySettings({
          get: () => '',
        } as unknown as ConfigService),
      );
      expect(await unlisted.check(aId, [cDoc.key], at)).toEqual([
        { key: null, refusal: 'uploaded_by_someone_else' },
      ]);
      // The same file, with the account listed, and A's own file without it.
      expect(await rule.check(aId, [cDoc.key], at)).toEqual([
        { key: cDoc.key, refusal: null },
      ]);
      const aDoc = await upload(aToken);
      expect(
        await unlisted.check(aId.toUpperCase(), [aDoc.fileUrl], at),
      ).toEqual([{ key: aDoc.key, refusal: null }]);
    });
  });
});
