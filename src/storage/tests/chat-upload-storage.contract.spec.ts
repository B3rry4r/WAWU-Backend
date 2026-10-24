import * as crypto from 'crypto';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'crypto';
import * as jwt from 'jsonwebtoken';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  PayloadTooLargeException,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthGuard } from '../../common/guards/wawu-auth.guard';
import { StorageModule } from '../storage.module';
import { StorageService } from '../storage.service';
import { StorageSweepService } from '../storage-sweep.service';

/**
 * FIX-104 round 2, on the real database and the real S3 client (a small
 * S3-style host on this machine's loopback, as upload-late-file.contract.spec).
 *
 * 1. A chat file never changes what the web reads: GET /uploads/usage,
 *    GET /uploads/allowance and a content presign answer as they did before
 *    chats carried files. A chat upload is the one that counts content plus
 *    chat, and is refused with the same 413 when the sum would pass the quota.
 * 2. An upload that landed and was never sent is given back: POST
 *    /uploads/release takes a chat key the person owns that no message carries
 *    (a message that carries it answers 409), the late-file sweep looks in the
 *    chat folders, and the unsent-chat sweep gives back a landed, unsent file a
 *    day on.
 */
const MB = 1024 * 1024;
const OWN = (n: number) =>
  `e1040000-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** The web's reads, and the content presign. */
const WEB = OWN(1);
/** A chat upload against a full quota. */
const CHATTER = OWN(2);
/** Releases and sweeps. */
const SENDER = OWN(3);
/** Somebody else, whose key is never ours to release. */
const OTHER = OWN(4);
/** The unsent-file sweep's own person. */
const SWEEPER = OWN(5);
const OWNED = [WEB, CHATTER, SENDER, OTHER, SWEEPER];
const BUCKET = 'fix104r2-bucket';

describe('Chat uploads on the storage routes (FIX-104 round 2, contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let storage: StorageService;
  let registry: SchedulerRegistry;
  let privateKey: string;
  let publicKey: string;
  let host: http.Server;
  const envSnapshot: Record<string, string | undefined> = {};

  const stored = new Set<string>();
  const deletesSeen: string[] = [];

  const server = (): App => app.getHttpServer() as App;
  const dataOf = <T>(res: { body: unknown }) => (res.body as { data: T }).data;
  const bearer = (sub: string) =>
    `Bearer ${jwt.sign(
      { sub, email: `${sub}@test.wawu.dev`, status: 'active' },
      privateKey,
      { algorithm: 'RS256', expiresIn: '15m' },
    )}`;

  class TestWawuAuthGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
      const req = context.switchToHttp().getRequest<{
        headers: Record<string, string | undefined>;
        user?: unknown;
      }>();
      const header = req.headers['authorization'];
      if (!header?.startsWith('Bearer ')) throw new UnauthorizedException();
      try {
        req.user = jwt.verify(header.slice('Bearer '.length), publicKey, {
          algorithms: ['RS256'],
        });
        return true;
      } catch {
        throw new UnauthorizedException();
      }
    }
  }

  const keyOf = (url: string | undefined) =>
    decodeURIComponent((url ?? '').split('?')[0]).replace(`/${BUCKET}/`, '');

  function startHost(): Promise<number> {
    host = http.createServer((req, res) => {
      const key = keyOf(req.url);
      if (req.method === 'PUT') {
        req.resume();
        req.on('end', () => {
          stored.add(key);
          res.statusCode = 200;
          res.end();
        });
        return;
      }
      if (req.method === 'DELETE') {
        deletesSeen.push(key);
        stored.delete(key);
        res.statusCode = 204;
        res.end();
        return;
      }
      if (req.method === 'HEAD') {
        res.statusCode = stored.has(key) ? 200 : 404;
        res.end();
        return;
      }
      res.statusCode = 405;
      res.end();
    });
    return new Promise((resolve) =>
      host.listen(0, '127.0.0.1', () =>
        resolve((host.address() as AddressInfo).port),
      ),
    );
  }

  const get = (sub: string, path: string) =>
    request(server()).get(path).set('Authorization', bearer(sub));
  const release = (sub: string, key: string) =>
    request(server())
      .post('/uploads/release')
      .set('Authorization', bearer(sub))
      .send({ key });
  const rowFor = (key: string) =>
    prisma.storageObject.findUniqueOrThrow({ where: { key } });

  /** A chat file that has landed (a confirmed row, and the object in the bucket). */
  async function landedChatFile(
    owner: string,
    bytes: number,
    opts: { folder?: 'chat/media' | 'chat/file'; hoursOld?: number } = {},
  ) {
    const folder = opts.folder ?? 'chat/media';
    const ext = folder === 'chat/file' ? 'pdf' : 'jpg';
    const key = `${folder}/${owner}/${randomUUID()}.${ext}`;
    await prisma.storageObject.create({
      data: {
        wawuUserId: owner,
        key,
        bytes,
        contentType: folder === 'chat/file' ? 'application/pdf' : 'image/jpeg',
        folder,
        status: 'confirmed',
        confirmedAt: new Date(),
        createdAt: new Date(Date.now() - (opts.hoursOld ?? 0) * 3_600_000),
      },
    });
    stored.add(key);
    return key;
  }

  /** A content file that counts toward the web's usage. */
  async function contentFile(owner: string, bytes: number) {
    const key = `content/full/${owner}/${randomUUID()}.mp4`;
    await prisma.storageObject.create({
      data: {
        wawuUserId: owner,
        key,
        bytes,
        contentType: 'video/mp4',
        folder: 'content/full',
        status: 'confirmed',
        confirmedAt: new Date(),
      },
    });
    return key;
  }

  /** `bytes` of files in `folder`, in rows of at most 1 GB (the column is a 32-bit integer). */
  async function fill(
    owner: string,
    folder: 'chat/media' | 'content/full',
    bytes: number,
  ) {
    for (let left = bytes; left > 0; left -= 1000 * MB) {
      const part = Math.min(left, 1000 * MB);
      if (folder === 'content/full') await contentFile(owner, part);
      else await landedChatFile(owner, part);
    }
  }

  /** A message of `owner` that carries `key`. */
  async function sendCarrying(owner: string, key: string) {
    const other = OWN(90 + Math.floor(Math.random() * 9));
    const chat = await prisma.chatConversation.create({
      data: { userAWawuId: owner, userBWawuId: `${other}-${randomUUID()}` },
    });
    await prisma.chatMessage.create({
      data: {
        conversationId: chat.id,
        senderWawuId: owner,
        kind: 'image',
        attachmentKey: key,
        attachmentContentType: 'image/jpeg',
        attachmentBytes: 1000,
      },
    });
    return chat.id;
  }

  const clean = async () => {
    await prisma.chatConversation.deleteMany({
      where: { userAWawuId: { in: OWNED } },
    });
    await prisma.storageObject.deleteMany({
      where: { wawuUserId: { in: OWNED } },
    });
  };

  beforeAll(async () => {
    const port = await startHost();
    const env: Record<string, string> = {
      STORAGE_ENDPOINT: `http://127.0.0.1:${port}`,
      STORAGE_ACCESS_KEY_ID: 'fix104r2-key',
      STORAGE_SECRET_ACCESS_KEY: 'fix104r2-secret',
      STORAGE_BUCKET: BUCKET,
      STORAGE_REGION: 'auto',
      STORAGE_FORCE_PATH_STYLE: 'true',
    };
    for (const [key, value] of Object.entries(env)) {
      envSnapshot[key] = process.env[key];
      process.env[key] = value;
    }
    const keyPair = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    privateKey = keyPair.privateKey;
    publicKey = keyPair.publicKey;

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        ScheduleModule.forRoot(),
        PrismaModule,
        StorageModule,
      ],
    })
      .overrideGuard(WawuAuthGuard)
      .useClass(TestWawuAuthGuard)
      .compile();

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
    storage = moduleRef.get(StorageService);
    registry = moduleRef.get(SchedulerRegistry);
    await registry.getCronJob('sweep-late-uploads').stop();
    await clean();
    await prisma.userProfile.deleteMany({
      where: { wawuUserId: { in: OWNED } },
    });
    await prisma.userProfile.createMany({
      data: OWNED.map((wawuUserId) => ({
        wawuUserId,
        accountType: 'creator' as const,
        creatorVerifiedAt: null,
        creatorVerifiedUntil: null,
        professionalVerifiedAt: null,
        professionalVerifiedUntil: null,
      })),
    });
    await prisma.makerTier.deleteMany({
      where: { wawuUserId: { in: OWNED } },
    });
    await prisma.makerTier.createMany({
      data: OWNED.map((wawuUserId) => ({
        wawuUserId,
        tierId: 'fix104r2-suite',
        activeFrom: new Date(Date.now() - 86_400_000),
        activeUntil: new Date(Date.now() + 30 * 86_400_000),
        productsIncluded: 30,
        pointsIncluded: 0,
      })),
    });
  });

  afterAll(async () => {
    await clean();
    await prisma?.makerTier.deleteMany({
      where: { wawuUserId: { in: OWNED } },
    });
    await prisma?.userProfile.deleteMany({
      where: { wawuUserId: { in: OWNED } },
    });
    await app?.close();
    await new Promise<void>((resolve) => host?.close(() => resolve()));
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(() => {
    deletesSeen.length = 0;
  });

  describe('what the web reads', () => {
    it('a chat file leaves GET /uploads/usage and GET /uploads/allowance byte-identical', async () => {
      await contentFile(WEB, 7 * MB);
      const usage = await get(WEB, '/uploads/usage').expect(200);
      const allowance = await get(WEB, '/uploads/allowance').expect(200);
      expect(dataOf<{ usedBytes: number }>(usage).usedBytes).toBe(7 * MB);

      await landedChatFile(WEB, 30 * MB);
      await landedChatFile(WEB, 2 * MB, { folder: 'chat/file' });

      const usageAfter = await get(WEB, '/uploads/usage').expect(200);
      const allowanceAfter = await get(WEB, '/uploads/allowance').expect(200);
      expect(usageAfter.text).toBe(usage.text);
      expect(allowanceAfter.text).toBe(allowance.text);
    });

    it('a content presign sums content only: a full chat does not refuse it, and the 413 words are unchanged', async () => {
      const { limitBytes, usedBytes } = await storage.usageFor(WEB);
      // Chat files that, with content, would be well past the limit.
      await fill(WEB, 'chat/media', limitBytes - usedBytes);
      const presign = await request(server())
        .post('/uploads/presign')
        .set('Authorization', bearer(WEB))
        .send({
          folder: 'content/full',
          contentType: 'video/mp4',
          extension: 'mp4',
          contentLength: 5 * MB,
        })
        .expect(200);
      expect(dataOf<{ key: string }>(presign).key).toContain('content/full/');
      // A content file that really does not fit is refused as it always was.
      await fill(
        WEB,
        'content/full',
        (await storage.usageFor(WEB)).remainingBytes - 2 * MB,
      );
      const after = await storage.usageFor(WEB);
      const refused = await request(server())
        .post('/uploads/presign')
        .set('Authorization', bearer(WEB))
        .send({
          folder: 'content/full',
          contentType: 'video/mp4',
          extension: 'mp4',
          contentLength: after.remainingBytes + MB,
        })
        .expect(413);
      expect(
        (refused.body as { reason: { code: string; usedBytes: number } })
          .reason,
      ).toMatchObject({
        code: 'storage_limit_reached',
        usedBytes: after.usedBytes,
      });
    });
  });

  describe('the chat path', () => {
    it('a chat upload is refused when content plus chat would pass the quota, in the same words as a content upload', async () => {
      const { limitBytes } = await storage.usageFor(CHATTER);
      // Half the quota in content and nearly the rest in chat.
      await fill(CHATTER, 'content/full', Math.floor(limitBytes / 2));
      await fill(CHATTER, 'chat/media', Math.floor(limitBytes / 2) - 1000);
      const need = 5000;

      const refusal = async (
        folder: 'chat/file' | 'content/full',
        type: string,
        ext: string,
      ): Promise<PayloadTooLargeException | null> => {
        try {
          await storage.presignUpload(CHATTER, folder, type, ext, need);
          return null;
        } catch (e) {
          return e instanceof PayloadTooLargeException ? e : null;
        }
      };
      const chat = await refusal('chat/file', 'application/pdf', '');
      expect(chat).not.toBeNull();
      const body = chat!.getResponse() as {
        message: string;
        reason: { code: string; neededBytes: number; usedBytes: number };
      };
      expect(body.reason.code).toBe('storage_limit_reached');
      expect(body.reason.neededBytes).toBe(need);
      expect(body.reason.usedBytes).toBe(limitBytes - 1000);
      expect(body.message).toMatch(
        /^This file needs .+, but only .+ of your .+ storage is free\.$/,
      );

      // What fits in chat is signed.
      await expect(
        storage.presignUpload(CHATTER, 'chat/file', 'application/pdf', '', 900),
      ).resolves.toMatchObject({
        key: expect.stringContaining('chat/file/') as string,
      });

      // The same size as content fits: a content presign counts content only.
      expect(await refusal('content/full', 'video/mp4', 'mp4')).toBeNull();
    });
  });

  describe('an upload that landed and was never sent', () => {
    it('POST /uploads/release gives back a chat key the person owns that no message carries', async () => {
      const { limitBytes } = await storage.usageFor(SENDER);
      // Chat files leave 1 MB free, with the one about to be released among them.
      await fill(SENDER, 'chat/media', limitBytes - 5 * MB);
      const key = await landedChatFile(SENDER, 4 * MB);
      expect(stored.has(key)).toBe(true);
      const tooBig = () =>
        storage.presignUpload(
          SENDER,
          'chat/file',
          'application/pdf',
          '',
          2 * MB,
        );
      await expect(tooBig()).rejects.toBeInstanceOf(PayloadTooLargeException);
      await release(SENDER, key).expect(200);
      expect(stored.has(key)).toBe(false);
      expect(deletesSeen).toEqual([key]);
      const row = await rowFor(key);
      expect(row.status).toBe('abandoned');
      expect(row.releasedAt).not.toBeNull();
      // It stops counting on the chat path: the 2 MB file now fits.
      await expect(tooBig()).resolves.toBeDefined();
      // Again: the same 200.
      await release(SENDER, key).expect(200);
    });

    it('releases a reserved chat key whose file never landed (a failed upload)', async () => {
      const { key } = await storage.presignUpload(
        SENDER,
        'chat/media',
        'image/jpeg',
        '',
        3 * MB,
      );
      expect((await rowFor(key)).status).toBe('pending');
      await release(SENDER, key).expect(200);
      expect((await rowFor(key)).status).toBe('abandoned');
    });

    it("a key a message carries answers 409 and stays; another person's chat key and an avatar answer 404", async () => {
      const key = await landedChatFile(SENDER, 1 * MB);
      await sendCarrying(SENDER, key);
      const res = await release(SENDER, key).expect(409);
      expect(res.body).toMatchObject({
        message: 'That file is already part of a message.',
        reason: { code: 'upload_claimed' },
      });
      expect(stored.has(key)).toBe(true);
      expect((await rowFor(key)).status).toBe('confirmed');

      const theirs = await landedChatFile(OTHER, 1 * MB);
      await release(SENDER, theirs).expect(404);
      expect(stored.has(theirs)).toBe(true);
    });

    it('the late-file sweep looks in the chat folders: a released chat file that landed again is deleted, one a message carries stays', async () => {
      const gone = await landedChatFile(SENDER, 1 * MB);
      await release(SENDER, gone).expect(200);
      // The upload link is still valid for its life: the file lands again.
      stored.add(gone);
      const kept = await landedChatFile(SENDER, 1 * MB);
      await sendCarrying(SENDER, kept);
      await prisma.storageObject.update({
        where: { key: kept },
        data: { status: 'abandoned' },
      });
      const old = new Date(Date.now() - 16 * 60 * 1000);
      await prisma.storageObject.updateMany({
        where: { key: { in: [gone, kept] } },
        data: { createdAt: old },
      });
      deletesSeen.length = 0;
      const result = await storage.sweepLateFiles(SENDER);
      expect(result.removed).toBe(1);
      expect(result.counted).toBe(1);
      expect(deletesSeen).toEqual([gone]);
      expect(stored.has(gone)).toBe(false);
      expect(stored.has(kept)).toBe(true);
      expect((await rowFor(kept)).status).toBe('confirmed');
      expect((await rowFor(gone)).sweptRemovedAt).not.toBeNull();
    });
  });

  describe('the unsent-chat-file sweep (a landed chat file no message carries, after 24 hours)', () => {
    it('gives back an unsent file a day old, and leaves a younger one, one a message carries and one of another content folder', async () => {
      const unsent = await landedChatFile(SWEEPER, 3 * MB, { hoursOld: 25 });
      const unsentPdf = await landedChatFile(SWEEPER, 1 * MB, {
        folder: 'chat/file',
        hoursOld: 30,
      });
      const young = await landedChatFile(SWEEPER, 3 * MB, { hoursOld: 23 });
      const carried = await landedChatFile(SWEEPER, 3 * MB, { hoursOld: 48 });
      await sendCarrying(SWEEPER, carried);
      const content = await contentFile(SWEEPER, 2 * MB);
      await prisma.storageObject.update({
        where: { key: content },
        data: { createdAt: new Date(Date.now() - 72 * 3_600_000) },
      });
      stored.add(content);

      deletesSeen.length = 0;
      const result = await storage.sweepUnsentChatUploads(SWEEPER);
      expect(result).toEqual({ released: 2, left: 0 });
      expect([...deletesSeen].sort()).toEqual([unsent, unsentPdf].sort());
      for (const key of [unsent, unsentPdf]) {
        const row = await rowFor(key);
        expect(row.status).toBe('abandoned');
        expect(row.releasedAt).not.toBeNull();
        expect(stored.has(key)).toBe(false);
      }
      for (const key of [young, carried, content]) {
        expect((await rowFor(key)).status).toBe('confirmed');
        expect(stored.has(key)).toBe(true);
      }

      // A second run has nothing to do.
      deletesSeen.length = 0;
      expect(await storage.sweepUnsentChatUploads(SWEEPER)).toEqual({
        released: 0,
        left: 0,
      });
      expect(deletesSeen).toEqual([]);

      // The timer runs it, at most once an hour, with the late-file sweep.
      const late = await landedChatFile(SWEEPER, 1 * MB, { hoursOld: 26 });
      await app.get(StorageSweepService).sweep();
      expect(stored.has(late)).toBe(false);
    });
  });
});
