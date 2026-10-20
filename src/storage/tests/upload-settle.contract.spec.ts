import * as crypto from 'crypto';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as jwt from 'jsonwebtoken';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Logger,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthGuard } from '../../common/guards/wawu-auth.guard';
import { TICK_STORAGE_BYTES } from '../../common/creator-allowance';
import { StorageModule } from '../storage.module';
import { StorageService } from '../storage.service';

/**
 * FIX-15 over HTTP, on the real database and the real S3 client: an upload the
 * storage host refuses does not keep counting against the person's storage.
 *
 *   POST /uploads/presign   (unchanged: reserves a StorageObject row)
 *   POST /uploads/confirm   (new: the app says it is done, the bucket answers)
 *   GET  /uploads/usage     (the figure a refused upload must not inflate)
 *
 * The bucket is a small S3-style server on this machine's loopback. The Hub
 * talks to it with the AWS SDK over real HTTP, the presigned URL it hands out
 * is PUT to for real, and the host refuses some of those PUTs with a 403. No
 * SDK call is replaced. Tokens are signed here and checked by a guard that
 * verifies them with this spec's public key, as upload-allowance.contract.spec
 * does. Every row is this spec's own and is deleted in afterAll.
 */
const MB = 1024 * 1024;
/**
 * Since TIER-02 (R-43) only a person who may publish is signed a file for
 * content, and that person's storage is the larger limit. Each person here
 * holds a running tier, so every figure below is measured against it.
 */
const LIMIT = TICK_STORAGE_BYTES;
/** One row holds at most 2 GB (the column is an INTEGER). */
const ROW_MAX = Math.floor(1.8 * 1024 * MB);
const OWN = (n: number) =>
  `f1500000-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** Refused and accepted uploads, and the retry after a refusal. */
const PERSON = OWN(1);
/** Somebody else, whose key PERSON must not be able to settle. */
const OTHER = OWN(2);
/** Stale reservations only: the sweep with no confirm call. */
const SWEEP = OWN(3);
/** Many stale reservations, more than one pass of the sweep. */
const MANY = OWN(4);
/** Confirm sent before the PUT, and files that land after a give-up. */
const EARLY = OWN(5);
const LATE = OWN(6);
const RACE = OWN(7);
const OWNED = [PERSON, OTHER, SWEEP, MANY, EARLY, LATE, RACE];
const BUCKET = 'fix15-bucket';

describe('A refused upload does not count against storage (FIX-15, contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let privateKey: string;
  let publicKey: string;
  let host: http.Server;
  const envSnapshot: Record<string, string | undefined> = {};

  /** What the storage host holds, and how it behaves right now. */
  const stored = new Set<string>();
  const refuse = new Set<string>();
  let outage = false;

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

  /** `/<bucket>/<key>` as the SDK addresses it in path style. */
  const keyOf = (url: string | undefined) =>
    decodeURIComponent((url ?? '').split('?')[0]).replace(`/${BUCKET}/`, '');

  function startHost(): Promise<number> {
    host = http.createServer((req, res) => {
      const key = keyOf(req.url);
      if (outage) {
        req.resume();
        res.statusCode = 500;
        res.end();
        return;
      }
      if (req.method === 'PUT') {
        req.resume();
        req.on('end', () => {
          if (refuse.has(key)) {
            res.statusCode = 403;
            res.setHeader('content-type', 'application/xml');
            res.end('<Error><Code>AccessDenied</Code></Error>');
            return;
          }
          stored.add(key);
          res.statusCode = 200;
          res.end();
        });
        return;
      }
      if (req.method === 'DELETE') {
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

  async function presign(sub: string, bytes: number) {
    return request(server())
      .post('/uploads/presign')
      .set('Authorization', bearer(sub))
      .send({
        folder: 'content/full',
        contentType: 'video/mp4',
        extension: 'mp4',
        contentLength: bytes,
      });
  }

  /** What the app does with the URL: PUT the bytes. Returns the host's status. */
  async function putTo(uploadUrl: string, bytes: number): Promise<number> {
    const res = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'video/mp4' },
      body: Buffer.alloc(bytes),
    });
    return res.status;
  }

  const confirm = (sub: string, body: unknown) =>
    request(server())
      .post('/uploads/confirm')
      .set('Authorization', bearer(sub))
      .send(body as object);

  async function usedBytes(sub: string): Promise<number> {
    const res = await request(server())
      .get('/uploads/usage')
      .set('Authorization', bearer(sub));
    expect(res.status).toBe(200);
    return dataOf<{ usedBytes: number }>(res).usedBytes;
  }

  const rowFor = (key: string) =>
    prisma.storageObject.findUniqueOrThrow({ where: { key } });

  /**
   * Content already stored and confirmed, as `bytes` in rows of at most
   * ROW_MAX, so a person is `bytes` into a limit far larger than one row.
   */
  async function alreadyStored(sub: string, bytes: number, tag: string) {
    const rows: number[] = [];
    for (let left = bytes; left > 0; left -= ROW_MAX) {
      rows.push(Math.min(left, ROW_MAX));
    }
    await prisma.storageObject.createMany({
      data: rows.map((rowBytes, n) => ({
        wawuUserId: sub,
        key: `content/full/${sub}/00000000-0000-4000-8000-${tag}${String(n).padStart(2, '0')}.mp4`,
        bytes: rowBytes,
        contentType: 'video/mp4',
        folder: 'content/full',
        status: 'confirmed' as const,
        confirmedAt: new Date('2026-09-01T00:00:00Z'),
      })),
    });
  }

  /**
   * Moves a reservation's presign time back: 7 minutes is past the life of
   * the upload URL (confirm gives up on a missing file), 20 is past the
   * sweep's grace.
   */
  const age = (key: string, minutes: number) =>
    prisma.storageObject.update({
      where: { key },
      data: { createdAt: new Date(Date.now() - minutes * 60 * 1000) },
    });

  beforeAll(async () => {
    const port = await startHost();
    const env: Record<string, string> = {
      STORAGE_ENDPOINT: `http://127.0.0.1:${port}`,
      STORAGE_ACCESS_KEY_ID: 'fix15-key',
      STORAGE_SECRET_ACCESS_KEY: 'fix15-secret',
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
    await prisma.storageObject.deleteMany({
      where: { wawuUserId: { in: OWNED } },
    });
    await prisma.makerTier.deleteMany({ where: { wawuUserId: { in: OWNED } } });
    await prisma.makerTier.createMany({
      data: OWNED.map((wawuUserId) => ({
        wawuUserId,
        tierId: 'fix15-suite',
        activeFrom: new Date(Date.now() - 86_400_000),
        activeUntil: new Date(Date.now() + 30 * 86_400_000),
        productsIncluded: 3,
        pointsIncluded: 0,
      })),
    });
  });

  afterAll(async () => {
    await prisma?.storageObject.deleteMany({
      where: { wawuUserId: { in: OWNED } },
    });
    await prisma?.makerTier.deleteMany({
      where: { wawuUserId: { in: OWNED } },
    });
    await app?.close();
    await new Promise<void>((resolve) => host?.close(() => resolve()));
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  afterEach(() => {
    outage = false;
  });

  describe('POST /uploads/confirm', () => {
    it('needs a signed-in person and a key', async () => {
      const anon = await request(server())
        .post('/uploads/confirm')
        .send({ key: 'content/full/x/y.mp4' });
      expect(anon.status).toBe(401);
      expect((await confirm(PERSON, {})).status).toBe(400);
      expect((await confirm(PERSON, { key: '' })).status).toBe(400);
      expect((await confirm(PERSON, { key: 'a', other: 1 })).status).toBe(400);
    });

    it('a refused upload gives its space back when the app confirms after the URL is spent', async () => {
      // 450 MB of room left, so a 400 MB file fits, and a second one does
      // not while the first one's reservation stands.
      const held = LIMIT - 450 * MB;
      await alreadyStored(PERSON, held, 'aaaaaaaaaa');
      const before = await usedBytes(PERSON);
      expect(before).toBe(held);

      const size = 400 * MB;
      const first = await presign(PERSON, size);
      expect(first.status).toBe(200);
      const firstKey = dataOf<{ key: string }>(first).key;
      refuse.add(firstKey);
      // The storage host turns the upload away.
      expect(
        await putTo(dataOf<{ uploadUrl: string }>(first).uploadUrl, 1),
      ).toBe(403);

      // The reservation still stands, so the same file cannot be tried again.
      expect(await usedBytes(PERSON)).toBe(before + size);
      expect((await presign(PERSON, size)).status).toBe(413);

      // The app says it is done while the URL could still be used: the
      // bucket does not have the file, but the row is left as it is.
      const early = await confirm(PERSON, { key: firstKey });
      expect(dataOf(early)).toEqual({ key: firstKey, status: 'pending' });
      expect((await rowFor(firstKey)).status).toBe('pending');
      expect(await usedBytes(PERSON)).toBe(before + size);

      // Once the URL is spent the bucket's answer is final.
      await age(firstKey, 7);
      const settled = await confirm(PERSON, { key: firstKey });
      expect(settled.status).toBe(200);
      expect(dataOf(settled)).toEqual({ key: firstKey, status: 'abandoned' });
      expect((await rowFor(firstKey)).status).toBe('abandoned');

      // The quota is as it was, and the retry goes through.
      expect(await usedBytes(PERSON)).toBe(before);
      const retry = await presign(PERSON, size);
      expect(retry.status).toBe(200);
      // Leave the room free for the cases below.
      const retryKey = dataOf<{ key: string }>(retry).key;
      await age(retryKey, 7);
      await confirm(PERSON, { key: retryKey });
      expect(await usedBytes(PERSON)).toBe(before);
    });

    it('a completed upload counts as before, and confirming it twice changes nothing', async () => {
      const before = await usedBytes(PERSON);
      const res = await presign(PERSON, 20 * MB);
      const { key, uploadUrl } = dataOf<{ key: string; uploadUrl: string }>(
        res,
      );
      expect(await putTo(uploadUrl, 1)).toBe(200);
      expect(await usedBytes(PERSON)).toBe(before + 20 * MB);

      const first = await confirm(PERSON, { key });
      expect(dataOf(first)).toEqual({ key, status: 'confirmed' });
      const row = await rowFor(key);
      expect(row.status).toBe('confirmed');
      expect(row.confirmedAt).not.toBeNull();
      expect(await usedBytes(PERSON)).toBe(before + 20 * MB);

      const again = await confirm(PERSON, { key });
      expect(dataOf(again)).toEqual({ key, status: 'confirmed' });
      expect((await rowFor(key)).confirmedAt).toEqual(row.confirmedAt);
      expect(await usedBytes(PERSON)).toBe(before + 20 * MB);
    });

    it('takes the fileUrl the presign answered with, as well as the key', async () => {
      const res = await presign(PERSON, 5 * MB);
      const { key, fileUrl, uploadUrl } = dataOf<{
        key: string;
        fileUrl: string;
        uploadUrl: string;
      }>(res);
      expect(await putTo(uploadUrl, 1)).toBe(200);
      const settled = await confirm(PERSON, { key: fileUrl });
      expect(dataOf(settled)).toEqual({ key, status: 'confirmed' });
    });

    it('counts a file that arrives after it was given up on', async () => {
      const before = await usedBytes(PERSON);
      const res = await presign(PERSON, 8 * MB);
      const { key, uploadUrl } = dataOf<{ key: string; uploadUrl: string }>(
        res,
      );

      // The app confirms, past the URL's life, while the host has nothing yet:
      // given up on.
      await age(key, 7);
      expect(dataOf(await confirm(PERSON, { key }))).toEqual({
        key,
        status: 'abandoned',
      });
      expect(await usedBytes(PERSON)).toBe(before);

      // Then the slow upload lands. The bucket is the truth: it counts again.
      expect(await putTo(uploadUrl, 1)).toBe(200);
      expect(dataOf(await confirm(PERSON, { key }))).toEqual({
        key,
        status: 'confirmed',
      });
      expect(await usedBytes(PERSON)).toBe(before + 8 * MB);
    });

    it("cannot settle somebody else's upload, and says what it says for a key that never existed", async () => {
      const theirs = await presign(OTHER, 4 * MB);
      const { key } = dataOf<{ key: string }>(theirs);

      const mine = await confirm(PERSON, { key });
      expect(mine.status).toBe(404);
      const nothing = await confirm(PERSON, {
        key: `content/full/${PERSON}/00000000-0000-4000-8000-000000000000.mp4`,
      });
      expect(nothing.status).toBe(404);
      expect((mine.body as { message: string }).message).toBe(
        (nothing.body as { message: string }).message,
      );
      expect((await rowFor(key)).status).toBe('pending');
    });

    it('changes nothing when the bucket cannot be asked', async () => {
      const res = await presign(PERSON, 6 * MB);
      const { key } = dataOf<{ key: string }>(res);
      const before = await usedBytes(PERSON);

      outage = true;
      const down = await confirm(PERSON, { key });
      expect(down.status).toBe(503);
      outage = false;

      expect((await rowFor(key)).status).toBe('pending');
      expect(await usedBytes(PERSON)).toBe(before);
    });
  });

  describe('confirm cannot be used to store past the limit (verifier finding, round 2)', () => {
    it('a confirm sent before the PUT frees nothing, so the limit still refuses the third 500 MB file', async () => {
      const size = 500 * MB;
      // 1 GiB of room left.
      const held = LIMIT - 1024 * MB;
      await alreadyStored(EARLY, held, 'dddddddddd');
      const uploads: { key: string; uploadUrl: string }[] = [];
      let refusedAt = -1;
      for (let n = 0; n < 8; n++) {
        const res = await presign(EARLY, size);
        if (res.status === 413) {
          refusedAt = n;
          break;
        }
        expect(res.status).toBe(200);
        const { key, uploadUrl } = dataOf<{ key: string; uploadUrl: string }>(
          res,
        );
        // The attack: confirm before the PUT, to get the space back at once.
        expect(dataOf(await confirm(EARLY, { key }))).toEqual({
          key,
          status: 'pending',
        });
        uploads.push({ key, uploadUrl });
      }
      // 2 x 500 MB fits in the 1 GiB left; the third does not, whatever was confirmed.
      expect(refusedAt).toBe(2);
      expect(uploads).toHaveLength(2);
      expect(await usedBytes(EARLY)).toBe(held + 2 * size);

      // The PUTs land; everything the bucket holds is counted, and still
      // nothing more can be presigned.
      for (const { uploadUrl } of uploads) {
        expect(await putTo(uploadUrl, 1)).toBe(200);
      }
      expect(await usedBytes(EARLY)).toBe(held + 2 * size);
      expect((await presign(EARLY, size)).status).toBe(413);
      for (const { key } of uploads) {
        expect(dataOf(await confirm(EARLY, { key }))).toEqual({
          key,
          status: 'confirmed',
        });
      }
      expect(await usedBytes(EARLY)).toBe(held + 2 * size);
    });

    it('a file that lands after it was given up on is refused and removed when it no longer fits', async () => {
      const size = 400 * MB;
      // 600 MB stored with 1 GiB of room in all: one 400 MB file fits, two do not.
      const held = LIMIT - 1024 * MB + 600 * MB;
      await alreadyStored(LATE, held, 'cccccccccc');
      const first = await presign(LATE, size);
      const { key, uploadUrl } = dataOf<{ key: string; uploadUrl: string }>(
        first,
      );
      // Given up on (URL spent, bucket empty): the room goes back.
      await age(key, 7);
      expect(
        dataOf<{ status: string }>(await confirm(LATE, { key })).status,
      ).toBe('abandoned');
      expect(await usedBytes(LATE)).toBe(held);

      // The room is used by another file.
      const second = await presign(LATE, size);
      expect(second.status).toBe(200);
      expect(await usedBytes(LATE)).toBe(held + size);

      // Then the slow upload lands. It does not fit: 413, the file is gone
      // from the bucket, the row stays abandoned, and the figure is the same.
      expect(await putTo(uploadUrl, 1)).toBe(200);
      expect(stored.has(key)).toBe(true);
      const refused = await confirm(LATE, { key });
      expect(refused.status).toBe(413);
      expect((refused.body as { reason: { code: string } }).reason.code).toBe(
        'storage_limit_reached',
      );
      expect(stored.has(key)).toBe(false);
      expect((await rowFor(key)).status).toBe('abandoned');
      expect(await usedBytes(LATE)).toBe(held + size);
    });

    it('two given-up files landing together take the last of the room once', async () => {
      const keys: string[] = [];
      for (let n = 0; n < 2; n++) {
        const res = await presign(RACE, 500 * MB);
        const { key, uploadUrl } = dataOf<{ key: string; uploadUrl: string }>(
          res,
        );
        await age(key, 7);
        expect(
          dataOf<{ status: string }>(await confirm(RACE, { key })).status,
        ).toBe('abandoned');
        expect(await putTo(uploadUrl, 1)).toBe(200);
        keys.push(key);
      }
      // 500 MB of room left: one 500 MB file fits, not two.
      await alreadyStored(RACE, LIMIT - 500 * MB, 'bbbbbbbbbb');
      const answers = await Promise.all(
        keys.map((key) => confirm(RACE, { key })),
      );
      expect(answers.map((a) => a.status).sort()).toEqual([200, 413]);
      expect(await usedBytes(RACE)).toBe(LIMIT);
      const rows = await Promise.all(keys.map((key) => rowFor(key)));
      expect(rows.map((r) => r.status).sort()).toEqual([
        'abandoned',
        'confirmed',
      ]);
    });

    it('a key with a NUL character is an unknown key (404), not a 500', async () => {
      const unknown = await confirm(PERSON, {
        key: `content/full/${PERSON}/00000000-0000-4000-8000-000000000000.mp4`,
      });
      expect(unknown.status).toBe(404);
      for (const key of ['a\u0000b', 'https://h.example/a\u0000b']) {
        const res = await confirm(PERSON, { key });
        expect(res.status).toBe(404);
        expect((res.body as { message: string }).message).toBe(
          (unknown.body as { message: string }).message,
        );
      }
    });
  });

  describe('the sweep, with no confirm call', () => {
    it('answers confirmed, not abandoned, when the sweep confirmed the row while the bucket was being asked (SWEEP-APP-1 FIX-15 L3)', async () => {
      const key = dataOf<{ key: string }>(await presign(PERSON, 1 * MB)).key;
      // old enough to be given up on, with no file in the bucket
      await prisma.storageObject.update({
        where: { key },
        data: { createdAt: new Date(Date.now() - 3_600_000) },
      });
      const service = app.get<{
        bucketHolds: (key: string, why: string) => Promise<string>;
      }>(StorageService);
      const asked = jest
        .spyOn(service, 'bucketHolds')
        .mockImplementationOnce(async () => {
          // the file landed and the sweep confirmed the row between this call's read and its write
          await prisma.storageObject.update({
            where: { key },
            data: { status: 'confirmed', confirmedAt: new Date() },
          });
          return 'absent';
        });
      try {
        expect(dataOf(await confirm(PERSON, { key }))).toEqual({
          key,
          status: 'confirmed',
        });
      } finally {
        asked.mockRestore();
      }
      expect((await rowFor(key)).status).toBe('confirmed');
    });

    it('gives back a reservation that never completed once the grace has passed, and keeps one that did', async () => {
      const gone = dataOf<{ key: string }>(await presign(SWEEP, 30 * MB)).key;
      const landed = await presign(SWEEP, 10 * MB);
      const landedKey = dataOf<{ key: string }>(landed).key;
      expect(
        await putTo(dataOf<{ uploadUrl: string }>(landed).uploadUrl, 1),
      ).toBe(200);
      const recent = dataOf<{ key: string }>(await presign(SWEEP, 1 * MB)).key;

      // Inside the grace nothing is settled: any of them may still arrive.
      expect(await usedBytes(SWEEP)).toBe(41 * MB);

      await age(gone, 16);
      await age(landedKey, 16);
      expect(await usedBytes(SWEEP)).toBe(11 * MB);
      expect((await rowFor(gone)).status).toBe('abandoned');
      expect((await rowFor(landedKey)).status).toBe('confirmed');
      expect((await rowFor(recent)).status).toBe('pending');
    });

    it('settles every stale reservation of a person, not only the first batch', async () => {
      const old = new Date(Date.now() - 20 * 60 * 1000);
      await prisma.storageObject.createMany({
        data: Array.from({ length: 120 }, (_, n) => ({
          wawuUserId: MANY,
          key: `content/full/${MANY}/${String(n).padStart(8, '0')}-0000-4000-8000-000000000000.mp4`,
          bytes: MB,
          contentType: 'video/mp4',
          folder: 'content/full',
          createdAt: old,
        })),
      });
      expect(await usedBytes(MANY)).toBe(0);
      expect(
        await prisma.storageObject.count({
          where: { wawuUserId: MANY, status: 'abandoned' },
        }),
      ).toBe(120);
    });

    it('keeps counting what it cannot check while the bucket is down, and ends', async () => {
      const old = new Date(Date.now() - 20 * 60 * 1000);
      await prisma.storageObject.deleteMany({ where: { wawuUserId: MANY } });
      await prisma.storageObject.createMany({
        data: Array.from({ length: 120 }, (_, n) => ({
          wawuUserId: MANY,
          key: `content/full/${MANY}/${String(n).padStart(8, '0')}-1111-4000-8000-000000000000.mp4`,
          bytes: MB,
          contentType: 'video/mp4',
          folder: 'content/full',
          createdAt: old,
        })),
      });
      // The refusals are the point of this case; keep the log readable.
      const quiet = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      outage = true;
      expect(await usedBytes(MANY)).toBe(120 * MB);
      outage = false;
      quiet.mockRestore();
      expect(
        await prisma.storageObject.count({
          where: { wawuUserId: MANY, status: 'pending' },
        }),
      ).toBe(120);
      // The bucket is back: the next read settles them.
      expect(await usedBytes(MANY)).toBe(0);
    }, 60000);
  });
});
