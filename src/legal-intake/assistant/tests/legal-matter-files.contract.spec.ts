// Run against a test database, always via `npm run test:contract`.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { ConfigModule } from '@nestjs/config';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  GEMINI_CLIENT,
  type GeminiBriefRequest,
  type GeminiChatRequest,
  type GeminiClient,
} from '../../../common/ai/gemini-client.interface';
import {
  adminFixtures,
  adminJwtSecrets,
  deleteAdminFixtures,
  loginAllAdmins,
  seedAdminFixtures,
} from '../../../common/tests/admin-session.helper';
import { LegalIntakeModule } from '../../legal-intake.module';
import { StorageService } from '../../../storage/storage.service';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'crypto';

/**
 * R2-LEGAL3: a person sends the documents a matter needs in the Legal chat,
 * before the work starts. A fixed-price matter ("Register a business") needs
 * an ID, two name options and an address; the files ride the Hub's chat upload
 * path (FIX-104), are stored on the matter, and the consultant's read lists them.
 *
 * The AI provider is a STAND-IN here: GEMINI_CLIENT is overridden with a
 * scripted client that records every request, so no test ever calls a real
 * model, needs a key, or asserts against what a model happened to say. The
 * records are also how the suite proves what is (and is not) sent to the
 * provider.
 *
 * Envelope note: ResponseInterceptor puts a plain result in `data`.
 */

const MOCK_WAWU_ID_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_WAWU_ID_BASE = `http://localhost:${MOCK_WAWU_ID_PORT}`;

// creator-basic in mock-wawu-id: Chidi Umeh. creator-pro is "someone else".
const ME = '00000000-0000-4000-8000-000000000002';
const ME_EMAIL = 'creator-basic@test.wawu.dev';
const OTHER = '00000000-0000-4000-8000-000000000003';

const ADMINS = adminFixtures('1e9a3300', 'legal-r2l3');
const SECRETS = adminJwtSecrets('legal-r2l3');

/** The scripted provider. Every request is kept for the privacy checks. */
class StandInGemini implements GeminiClient {
  chats: GeminiChatRequest[] = [];
  briefs: GeminiBriefRequest[] = [];
  private chatAnswers: Array<string | Error> = [];
  briefAnswer: { summary: string } | Error = {
    summary: 'A tenant faces a mid-lease rent rise.',
  };

  queue(...answers: Array<string | Error | Record<string, unknown>>) {
    for (const a of answers) {
      this.chatAnswers.push(
        typeof a === 'string' || a instanceof Error ? a : JSON.stringify(a),
      );
    }
  }

  reset() {
    this.chats = [];
    this.briefs = [];
    this.chatAnswers = [];
    this.briefAnswer = { summary: 'A tenant faces a mid-lease rent rise.' };
  }

  chat(req: GeminiChatRequest): Promise<string> {
    this.chats.push(req);
    const next = this.chatAnswers.shift();
    if (next === undefined) {
      return Promise.reject(new Error('stand-in has no answer queued'));
    }
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  }

  generateBrief(req: GeminiBriefRequest) {
    this.briefs.push(req);
    if (this.briefAnswer instanceof Error) {
      return Promise.reject(this.briefAnswer);
    }
    return Promise.resolve({
      summary: this.briefAnswer.summary,
      keyIssues: ['Whether the lease allows a rent review'],
      questionsToClarify: ['What does the review clause say?'],
      risks: [],
    });
  }
}

async function waitForHealth(url: string, timeoutMs = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      /* not up yet */
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

const BUCKET = 'r2l3-bucket';

interface Msg {
  id: string;
  authorRole: string;
  body: string;
  attachment?: null | {
    url: string | null;
    contentType: string;
    bytes: number;
    name: string | null;
  };
}
interface Thread {
  id: string;
  messages: Msg[];
  legalRequestId: string | null;
  requestStatus: string | null;
}
interface Refusal {
  message: string;
  reason?: { code: string };
}
const data = <T = Thread>(res: { body: unknown }): T =>
  (res.body as { data: T }).data;
const refused = (res: { body: unknown }): Refusal => res.body as Refusal;

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3, 4, 5]);
const PDF = Buffer.from('%PDF-1.4\n%%EOF\n');

describe('Legal matter files: the documents a person sends before the work starts (R2-LEGAL3, contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let storage: StorageService;
  let mockWawuId: ChildProcess | undefined;
  let owned = false;
  let token: string;
  let otherToken: string;
  let admins: Awaited<ReturnType<typeof loginAllAdmins>>;
  let host: http.Server;
  const landed = new Set<string>();
  const gemini = new StandInGemini();
  const envSnapshot: Record<string, string | undefined> = {};

  const http_ = () => request(app.getHttpServer() as App);
  const as = (t: string) => ({ Authorization: `Bearer ${t}` });
  const keyOf = (url: string | undefined) =>
    decodeURIComponent((url ?? '').split('?')[0]).replace(`/${BUCKET}/`, '');

  function startHost(): Promise<number> {
    host = http.createServer((req, res) => {
      const key = keyOf(req.url);
      if (req.method === 'PUT') {
        req.resume();
        req.on('end', () => {
          landed.add(key);
          res.statusCode = 200;
          res.end();
        });
        return;
      }
      if (req.method === 'DELETE') {
        landed.delete(key);
        res.statusCode = 204;
        res.end();
        return;
      }
      res.statusCode = landed.has(key) ? 200 : 404;
      res.end();
    });
    return new Promise((resolve) =>
      host.listen(0, '127.0.0.1', () =>
        resolve((host.address() as AddressInfo).port),
      ),
    );
  }

  async function cleanUp() {
    const intakes = await prisma.legalIntake.findMany({
      where: { wawuUserId: { in: [ME, OTHER] } },
      select: { legalRequestId: true },
    });
    const requestIds = intakes
      .map((i) => i.legalRequestId)
      .filter((v): v is string => Boolean(v));
    await prisma.legalIntakeMessage.deleteMany({
      where: { wawuUserId: { in: [ME, OTHER] } },
    });
    await prisma.legalIntake.deleteMany({
      where: { wawuUserId: { in: [ME, OTHER] } },
    });
    if (requestIds.length > 0) {
      await prisma.legalChatMessage.deleteMany({
        where: { legalRequestId: { in: requestIds } },
      });
    }
    await prisma.legalRequest.deleteMany({
      where: { wawuUserId: { in: [ME, OTHER] } },
    });
    await prisma.storageObject.deleteMany({
      where: { wawuUserId: { in: [ME, OTHER] } },
    });
    await prisma.legalServicePrice.deleteMany({
      where: { serviceCode: 'cac-registration' },
    });
  }

  beforeAll(async () => {
    const port = await startHost();
    const env: Record<string, string> = {
      ADMIN_JWT_SECRET: SECRETS.access,
      ADMIN_JWT_REFRESH_SECRET: SECRETS.refresh,
      STORAGE_ENDPOINT: `http://127.0.0.1:${port}`,
      STORAGE_ACCESS_KEY_ID: 'r2l3-key',
      STORAGE_SECRET_ACCESS_KEY: 'r2l3-secret',
      STORAGE_BUCKET: BUCKET,
      STORAGE_REGION: 'auto',
      STORAGE_FORCE_PATH_STYLE: 'true',
    };
    for (const [key, value] of Object.entries(env)) {
      envSnapshot[key] = process.env[key];
      process.env[key] = value;
    }

    if (!(await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`, 1500))) {
      mockWawuId = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '../../../../mock-wawu-id'),
        env: { ...process.env, MOCK_WAWU_ID_PORT },
        stdio: 'ignore',
      });
      owned = true;
      await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`);
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        LegalIntakeModule,
      ],
    })
      .overrideProvider(GEMINI_CLIENT)
      .useValue(gemini)
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

    prisma = moduleRef.get(PrismaService);
    storage = moduleRef.get(StorageService);
    await cleanUp();
    await seedAdminFixtures(prisma, ADMINS);
    admins = await loginAllAdmins(app, ADMINS);
    token = await login(ME_EMAIL);
    otherToken = await login('creator-pro@test.wawu.dev');
  }, 40000);

  afterEach(async () => {
    await cleanUp();
    gemini.reset();
    landed.clear();
  });

  afterAll(async () => {
    if (prisma) {
      await cleanUp();
      await deleteAdminFixtures(prisma, ADMINS);
    }
    await app?.close();
    await new Promise((r) => host?.close(r));
    if (owned && mockWawuId) mockWawuId.kill();
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }, 30000);

  /** A conversation about a business name, with the price WAWU set, started as the fixed-price request (S26). */
  async function fixedPriceMatter(t = token, who = ME) {
    await prisma.legalServicePrice.upsert({
      where: { serviceCode: 'cac-registration' },
      create: { serviceCode: 'cac-registration', priceKobo: 3_500_000 },
      update: { priceKobo: 3_500_000 },
    });
    const intake = await prisma.legalIntake.create({
      data: {
        wawuUserId: who,
        matter: 'business_registration',
        channel: 'assistant',
        answers: {},
        documents: [],
      },
    });
    await prisma.legalIntakeMessage.create({
      data: {
        legalIntakeId: intake.id,
        wawuUserId: who,
        authorRole: 'client',
        body: 'I want to register my business name.',
      },
    });
    const started = data(
      await http_()
        .post(`/api/hub/legal/assistant/${intake.id}/start`)
        .set(as(t))
        .send({ firstNameChoice: 'Ada Bakes' })
        .expect(201),
    );
    return { id: intake.id, requestId: started.legalRequestId as string };
  }

  const presign = (id: string, body: object, t = token) =>
    http_()
      .post(`/api/hub/legal/assistant/${id}/attachments`)
      .set(as(t))
      .send(body);
  const say = (id: string, body: object, t = token) =>
    http_()
      .post(`/api/hub/legal/assistant/${id}/messages`)
      .set(as(t))
      .send(body);

  /** The whole path a phone takes: ask where, PUT the bytes. Answers the key. */
  async function upload(id: string, contentType: string, bytes: Buffer) {
    const res = await presign(id, {
      contentType,
      contentLength: bytes.length,
    }).expect(201);
    const target = data<{ uploadUrl: string; key: string }>(res);
    const put = await fetch(target.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': contentType },
      body: new Uint8Array(bytes),
    });
    expect(put.ok).toBe(true);
    return target.key;
  }

  it('lets a person attach an ID picture and a PDF to a fixed-price matter, with no model call, and the consultant reads both', async () => {
    const { id, requestId } = await fixedPriceMatter();

    const photoKey = await upload(id, 'image/jpeg', JPEG);
    expect(photoKey.startsWith(`chat/media/${ME}/`)).toBe(true);
    const afterPhoto = data(
      await say(id, { attachment: { key: photoKey } }).expect(201),
    );
    const pdfKey = await upload(id, 'application/pdf', PDF);
    expect(pdfKey.startsWith(`chat/file/${ME}/`)).toBe(true);
    const afterPdf = data(
      await say(id, {
        attachment: { key: pdfKey, name: 'Passport page.pdf' },
      }).expect(201),
    );

    // The client's own read: both files, in the conversation, each with a link.
    const lines = afterPdf.messages.filter((m) => m.attachment);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      authorRole: 'client',
      body: 'Sent a photo.',
      attachment: { contentType: 'image/jpeg', bytes: JPEG.length, name: null },
    });
    expect(lines[0].attachment?.url).toContain(photoKey);
    expect(lines[1]).toMatchObject({
      authorRole: 'client',
      body: 'Sent a file: Passport page.pdf.',
      attachment: {
        contentType: 'application/pdf',
        bytes: PDF.length,
        name: 'Passport page.pdf',
      },
    });
    expect(afterPhoto.messages.filter((m) => m.attachment)).toHaveLength(1);

    // Stored on the matter, where the consultant reads what was handed over.
    const request = await prisma.legalRequest.findUniqueOrThrow({
      where: { id: requestId },
    });
    expect(request.documents).toEqual([photoKey, pdfKey]);
    // A file is never a paid assistant call.
    expect(gemini.chats).toHaveLength(0);
    expect(
      await prisma.legalAssistantCall.count({ where: { wawuUserId: ME } }),
    ).toBe(0);

    // The consultant's admin read lists both, each with a link of its own.
    const ops = await http_()
      .get(`/api/hub/legal/ops/intakes/chat/${requestId}`)
      .set(as(admins.support))
      .expect(200);
    const seen = data<{ messages: Msg[] }>(ops).messages.filter(
      (m) => m.attachment,
    );
    expect(seen.map((m) => m.attachment?.contentType)).toEqual([
      'image/jpeg',
      'application/pdf',
    ]);
    expect(seen[0].attachment?.url).toContain(photoKey);
    expect(seen[1].attachment?.url).toContain(pdfKey);
    expect(seen[1].attachment?.name).toBe('Passport page.pdf');
  });

  it('sending the same file again is one line, and a lost answer is safe', async () => {
    const { id, requestId } = await fixedPriceMatter();
    const key = await upload(id, 'image/jpeg', JPEG);
    await say(id, { attachment: { key } }).expect(201);
    const again = data(await say(id, { attachment: { key } }).expect(201));
    expect(again.messages.filter((m) => m.attachment)).toHaveLength(1);
    const request = await prisma.legalRequest.findUniqueOrThrow({
      where: { id: requestId },
    });
    expect(request.documents).toEqual([key]);
  });

  it("refuses a file before the matter exists, on words, on a key that is not the sender's, and on one that never landed", async () => {
    // No request yet.
    const open = await prisma.legalIntake.create({
      data: {
        wawuUserId: ME,
        matter: 'business_registration',
        channel: 'assistant',
        answers: {},
        documents: [],
      },
    });
    const early = await presign(open.id, {
      contentType: 'image/jpeg',
      contentLength: 10,
    }).expect(409);
    expect(refused(early).reason?.code).toBe('matter_not_open');
    const earlySend = await say(open.id, {
      attachment: { key: `chat/media/${ME}/${randomUUID()}.jpg` },
    }).expect(409);
    expect(refused(earlySend).reason?.code).toBe('matter_not_open');
    await prisma.legalIntake.delete({ where: { id: open.id } });

    const { id } = await fixedPriceMatter();
    // Words and a file together.
    const both = await say(id, {
      body: 'here you go',
      attachment: { key: `chat/media/${ME}/${randomUUID()}.jpg` },
    }).expect(400);
    expect(refused(both).reason?.code).toBe('message_empty');
    // Another person's key.
    await say(id, {
      attachment: { key: `chat/media/${OTHER}/${randomUUID()}.jpg` },
    }).expect(400);
    // A key signed for and never PUT.
    const presigned = await presign(id, {
      contentType: 'image/jpeg',
      contentLength: 10,
    }).expect(201);
    const never = data<{ key: string }>(presigned).key;
    await say(id, { attachment: { key: never } }).expect(400);
    // A type a chat does not hold.
    await presign(id, { contentType: 'text/html', contentLength: 10 }).expect(
      400,
    );
  });

  it("is the owner's alone: another person's conversation answers 404", async () => {
    const { id } = await fixedPriceMatter();
    await presign(
      id,
      { contentType: 'image/jpeg', contentLength: 10 },
      otherToken,
    ).expect(404);
    await say(
      id,
      { attachment: { key: `chat/media/${OTHER}/${randomUUID()}.jpg` } },
      otherToken,
    ).expect(404);
    await http_()
      .post(`/api/hub/legal/assistant/${id}/attachments`)
      .send({ contentType: 'image/jpeg', contentLength: 10 })
      .expect(401);
  });

  it("keeps to the chat's sizes and refuses once the matter is finished or full", async () => {
    const { id, requestId } = await fixedPriceMatter();
    const big = await presign(id, {
      contentType: 'application/pdf',
      contentLength: 20 * 1024 * 1024 + 1,
    }).expect(413);
    expect(refused(big).message).toContain('20 MB');

    // 20 files is the most a matter holds.
    for (let i = 0; i < 20; i++) {
      await prisma.legalChatMessage.create({
        data: {
          legalRequestId: requestId,
          authorRole: 'client',
          body: 'Sent a photo.',
          attachmentKey: `chat/media/${ME}/${randomUUID()}.jpg`,
          attachmentContentType: 'image/jpeg',
          attachmentBytes: 10,
        },
      });
    }
    const full = await presign(id, {
      contentType: 'image/jpeg',
      contentLength: 10,
    }).expect(409);
    expect(refused(full).reason?.code).toBe('matter_files_full');
    await prisma.legalChatMessage.deleteMany({
      where: { legalRequestId: requestId, attachmentKey: { not: null } },
    });

    await prisma.legalRequest.update({
      where: { id: requestId },
      data: { status: 'delivered' },
    });
    const done = await presign(id, {
      contentType: 'image/jpeg',
      contentLength: 10,
    }).expect(409);
    expect(refused(done).reason?.code).toBe('matter_closed');
  });

  it('a file a line carries is never given back as unsent, and a release of it answers 409', async () => {
    const { id } = await fixedPriceMatter();
    const kept = await upload(id, 'image/jpeg', JPEG);
    await say(id, { attachment: { key: kept } }).expect(201);
    const unsent = await upload(id, 'application/pdf', PDF);
    // Both landed; only the first is on the matter. Confirm the second.
    await prisma.storageObject.updateMany({
      where: { key: { in: [kept, unsent] } },
      data: {
        status: 'confirmed',
        confirmedAt: new Date(),
        createdAt: new Date(Date.now() - 48 * 3_600_000),
      },
    });
    const released = await http_()
      .post('/api/hub/uploads/release')
      .set(as(token))
      .send({ key: kept })
      .expect(409);
    expect(refused(released).reason?.code).toBe('upload_claimed');

    const result = await storage.sweepUnsentChatUploads(ME);
    expect(result.released).toBe(1);
    expect(landed.has(kept)).toBe(true);
    expect(landed.has(unsent)).toBe(false);
    const row = await prisma.storageObject.findUniqueOrThrow({
      where: { key: kept },
    });
    expect(row.status).toBe('confirmed');
  });
});
