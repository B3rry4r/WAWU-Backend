import * as crypto from 'crypto';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as jwt from 'jsonwebtoken';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
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
 * ME-04 round 3 over HTTP, on the real database and the real S3 client.
 *
 * A presigned PUT link stays valid for its whole life after the upload was
 * released, so presign (counted), send, release (uncounted), send again leaves
 * a file in the bucket that nothing counts. The verifier's repro (a4.py) did
 * that four times and held 85,983,232 bytes with usedBytes 0.
 *
 *   - The Hub's sweep removes that file once the link has expired (300 s plus
 *     a margin), and records that it did. It never touches a claimed key, and
 *     a bucket that cannot be asked leaves the row for the next pass.
 *   - POST /uploads/confirm (FIX-15) does not count a released row again when a
 *     late file lands: the row stays released.
 *
 * The bucket is a small S3-style server on this machine's loopback, spoken to
 * by the AWS SDK over real HTTP; the presigned link is PUT to for real. Tokens
 * are signed here and checked by a guard that uses this spec's public key. Every
 * row is this spec's own and is deleted in afterAll.
 */
const MB = 1024 * 1024;
const OWN = (n: number) =>
  `e0430000-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** Presign, send, release, send again (the verifier's repro). */
const LOOPER = OWN(1);
/** Confirm after a release. */
const CONFIRMER = OWN(2);
/** A key a listing uses. */
const CLAIMER = OWN(3);
/** A bucket that is down, then back. */
const OUTAGE = OWN(4);
/** Somebody else's rows, which a sweep of another person leaves alone. */
const BYSTANDER = OWN(5);
/** Rows that never arrived, and rows outside the content folders. */
const OTHERS = OWN(6);
const OWNED = [LOOPER, CONFIRMER, CLAIMER, OUTAGE, BYSTANDER, OTHERS];
const BUCKET = 'me04-r3-bucket';

describe('A file that lands after its upload was released (ME-04 round 3, contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let storage: StorageService;
  let timer: StorageSweepService;
  let registry: SchedulerRegistry;
  let privateKey: string;
  let publicKey: string;
  let host: http.Server;
  const envSnapshot: Record<string, string | undefined> = {};

  /** What the storage host holds, and how it behaves right now. */
  const stored = new Set<string>();
  let headDown = false;
  let deleteRefused = false;
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

  /** `/<bucket>/<key>` as the SDK addresses it in path style. */
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
        if (deleteRefused) {
          res.statusCode = 500;
          res.end();
          return;
        }
        deletesSeen.push(key);
        stored.delete(key);
        res.statusCode = 204;
        res.end();
        return;
      }
      if (req.method === 'HEAD') {
        if (headDown) {
          res.statusCode = 503;
          res.end();
          return;
        }
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
    const res = await request(server())
      .post('/uploads/presign')
      .set('Authorization', bearer(sub))
      .send({
        folder: 'content/full',
        contentType: 'video/mp4',
        extension: 'mp4',
        contentLength: bytes,
      })
      .expect(200);
    return dataOf<{ key: string; fileUrl: string; uploadUrl: string }>(res);
  }

  /** What the app does with the link: PUT the bytes. Returns the host's status. */
  async function putTo(uploadUrl: string, bytes = 1): Promise<number> {
    const res = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'video/mp4' },
      body: Buffer.alloc(bytes),
    });
    return res.status;
  }

  const release = (sub: string, key: string) =>
    request(server())
      .post('/uploads/release')
      .set('Authorization', bearer(sub))
      .send({ key });

  const confirm = (sub: string, key: string) =>
    request(server())
      .post('/uploads/confirm')
      .set('Authorization', bearer(sub))
      .send({ key });

  async function usedBytes(sub: string): Promise<number> {
    const res = await request(server())
      .get('/uploads/allowance')
      .set('Authorization', bearer(sub))
      .expect(200);
    return dataOf<{ storage: { usedBytes: number } }>(res).storage.usedBytes;
  }

  const rowFor = (key: string) =>
    prisma.storageObject.findUniqueOrThrow({ where: { key } });

  /** Moves a reservation's presign time back by `minutes`. */
  const age = (key: string, minutes: number) =>
    prisma.storageObject.update({
      where: { key },
      data: { createdAt: new Date(Date.now() - minutes * 60 * 1000) },
    });

  beforeAll(async () => {
    const port = await startHost();
    const env: Record<string, string> = {
      STORAGE_ENDPOINT: `http://127.0.0.1:${port}`,
      STORAGE_ACCESS_KEY_ID: 'me04-r3-key',
      STORAGE_SECRET_ACCESS_KEY: 'me04-r3-secret',
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
    timer = moduleRef.get(StorageSweepService);
    registry = moduleRef.get(SchedulerRegistry);
    await prisma.contentPiece.deleteMany({
      where: { creatorWawuId: { in: OWNED } },
    });
    await prisma.storageObject.deleteMany({
      where: { wawuUserId: { in: OWNED } },
    });
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
  });

  afterAll(async () => {
    await prisma?.contentPiece.deleteMany({
      where: { creatorWawuId: { in: OWNED } },
    });
    await prisma?.storageObject.deleteMany({
      where: { wawuUserId: { in: OWNED } },
    });
    await prisma?.creatorState.deleteMany({
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
    headDown = false;
    deleteRefused = false;
    deletesSeen.length = 0;
  });

  describe('the sweep', () => {
    it("the verifier's repro: presign, send, release, send again, repeated, ends with every object gone and usedBytes unchanged", async () => {
      const before = await usedBytes(LOOPER);
      const keys: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const p = await presign(LOOPER, 20 * MB);
        keys.push(p.key);
        expect(await putTo(p.uploadUrl)).toBe(200);
        await release(LOOPER, p.key).expect(200);
        expect(stored.has(p.key)).toBe(false);
        // The link is still valid: the file lands again, and nothing counts it.
        expect(await putTo(p.uploadUrl)).toBe(200);
        expect(stored.has(p.key)).toBe(true);
      }
      expect(await usedBytes(LOOPER)).toBe(before);
      for (const key of keys)
        expect((await rowFor(key)).status).toBe('abandoned');

      // Inside the link's life and its margin the sweep leaves them: the
      // sender may still be mid-upload.
      await age(keys[0], 4);
      await age(keys[1], 9);
      await age(keys[2], 14);
      let result = await storage.sweepLateFiles(LOOPER);
      expect(result).toEqual({ settled: 0, removed: 0, left: 0 });
      for (const key of keys) expect(stored.has(key)).toBe(true);

      // Past the link's life plus the margin (15 minutes) the files go.
      for (const key of keys) await age(key, 16);
      deletesSeen.length = 0;
      result = await storage.sweepLateFiles(LOOPER);
      expect(result).toEqual({ settled: 3, removed: 3, left: 0 });
      for (const key of keys) expect(stored.has(key)).toBe(false);
      expect([...deletesSeen].sort()).toEqual([...keys].sort());
      expect(await usedBytes(LOOPER)).toBe(before);

      // It records that it did.
      for (const key of keys) {
        const row = await rowFor(key);
        expect(row.status).toBe('abandoned');
        expect(row.releasedAt).not.toBeNull();
        expect(row.sweptAt).not.toBeNull();
        expect(row.sweptRemovedAt).not.toBeNull();
      }

      // A second pass has nothing left to do and sends nothing to the bucket.
      deletesSeen.length = 0;
      expect(await storage.sweepLateFiles(LOOPER)).toEqual({
        settled: 0,
        removed: 0,
        left: 0,
      });
      expect(deletesSeen).toEqual([]);
    });

    it('settles a released row whose file never came back without deleting anything, and records that it looked', async () => {
      const p = await presign(LOOPER, 3 * MB);
      expect(await putTo(p.uploadUrl)).toBe(200);
      await release(LOOPER, p.key).expect(200);
      await age(p.key, 16);

      deletesSeen.length = 0;
      const result = await storage.sweepLateFiles(LOOPER);
      expect(result).toEqual({ settled: 1, removed: 0, left: 0 });
      expect(deletesSeen).toEqual([]);
      const row = await rowFor(p.key);
      expect(row.sweptAt).not.toBeNull();
      expect(row.sweptRemovedAt).toBeNull();
    });

    it('also removes the late file of an upload that never arrived in time, not only a released one', async () => {
      const p = await presign(OTHERS, 6 * MB);
      // The app confirms past the link's life with nothing there: given up on.
      await age(p.key, 7);
      expect(dataOf(await confirm(OTHERS, p.key))).toEqual({
        key: p.key,
        status: 'abandoned',
      });
      expect((await rowFor(p.key)).releasedAt).toBeNull();
      // A slow upload then lands, and nobody confirms it.
      expect(await putTo(p.uploadUrl)).toBe(200);
      await age(p.key, 16);

      const result = await storage.sweepLateFiles(OTHERS);
      expect(result.removed).toBe(1);
      expect(stored.has(p.key)).toBe(false);
      expect((await rowFor(p.key)).sweptRemovedAt).not.toBeNull();
    });

    it('never touches a key a listing uses', async () => {
      const p = await presign(CLAIMER, 4 * MB);
      expect(await putTo(p.uploadUrl)).toBe(200);
      await release(CLAIMER, p.key).expect(200);
      expect(await putTo(p.uploadUrl)).toBe(200);
      // A listing then takes the file (a create that did not check the row, as
      // the sweep list says).
      const piece = await prisma.contentPiece.create({
        data: {
          slug: 'me04-r3-claimed',
          creatorWawuId: CLAIMER,
          contentType: 'video',
          title: 'Claimed',
          description: 'Fixture',
          category: 'business_entrepreneurship',
          accessType: 'free',
          price: 0,
          previewAssetUrl: 'https://cdn.example.com/p.jpg',
          fullAssetUrl: p.fileUrl,
          status: 'pending',
        },
      });
      await age(p.key, 30);

      deletesSeen.length = 0;
      const result = await storage.sweepLateFiles(CLAIMER);
      expect(result).toEqual({ settled: 1, removed: 0, left: 0 });
      expect(stored.has(p.key)).toBe(true);
      expect(deletesSeen).toEqual([]);
      const row = await rowFor(p.key);
      expect(row.sweptRemovedAt).toBeNull();
      await prisma.contentPiece.delete({ where: { id: piece.id } });
    });

    it('leaves the row for the next pass when the bucket cannot be asked or refuses the delete', async () => {
      const p = await presign(OUTAGE, 5 * MB);
      expect(await putTo(p.uploadUrl)).toBe(200);
      await release(OUTAGE, p.key).expect(200);
      expect(await putTo(p.uploadUrl)).toBe(200);
      await age(p.key, 16);

      headDown = true;
      expect(await storage.sweepLateFiles(OUTAGE)).toEqual({
        settled: 0,
        removed: 0,
        left: 1,
      });
      expect(stored.has(p.key)).toBe(true);
      expect((await rowFor(p.key)).sweptAt).toBeNull();

      headDown = false;
      deleteRefused = true;
      expect(await storage.sweepLateFiles(OUTAGE)).toEqual({
        settled: 0,
        removed: 0,
        left: 1,
      });
      expect(stored.has(p.key)).toBe(true);
      expect((await rowFor(p.key)).sweptAt).toBeNull();

      deleteRefused = false;
      expect(await storage.sweepLateFiles(OUTAGE)).toEqual({
        settled: 1,
        removed: 1,
        left: 0,
      });
      expect(stored.has(p.key)).toBe(false);
      expect((await rowFor(p.key)).sweptRemovedAt).not.toBeNull();
    });

    it('sweeps one person without touching another, leaves counted files alone and ignores the other folders', async () => {
      const mine = await presign(BYSTANDER, 2 * MB);
      expect(await putTo(mine.uploadUrl)).toBe(200);
      await release(BYSTANDER, mine.key).expect(200);
      expect(await putTo(mine.uploadUrl)).toBe(200);
      await age(mine.key, 16);

      const counted = await presign(BYSTANDER, 2 * MB);
      expect(await putTo(counted.uploadUrl)).toBe(200);
      await age(counted.key, 16);

      // An abandoned row in a folder the allowance does not count.
      const avatarKey = `avatars/${BYSTANDER}/late.jpg`;
      await prisma.storageObject.create({
        data: {
          wawuUserId: BYSTANDER,
          key: avatarKey,
          bytes: 1000,
          contentType: 'image/jpeg',
          folder: 'avatars',
          status: 'abandoned',
          createdAt: new Date(Date.now() - 60 * 60 * 1000),
        },
      });
      stored.add(avatarKey);

      // Another person's sweep does not reach these rows.
      expect(await storage.sweepLateFiles(LOOPER)).toEqual({
        settled: 0,
        removed: 0,
        left: 0,
      });
      expect(stored.has(mine.key)).toBe(true);

      const result = await storage.sweepLateFiles(BYSTANDER);
      expect(result).toEqual({ settled: 1, removed: 1, left: 0 });
      expect(stored.has(mine.key)).toBe(false);
      // The pending, counted file and the avatar are not the sweep's.
      expect(stored.has(counted.key)).toBe(true);
      expect((await rowFor(counted.key)).status).toBe('pending');
      expect(stored.has(avatarKey)).toBe(true);
      expect((await rowFor(avatarKey)).sweptAt).toBeNull();
    });

    it('is on a timer in the Hub: the job is registered, and its body sweeps everyone', async () => {
      expect(registry.getCronJobs().has('sweep-late-uploads')).toBe(true);
      const a = await presign(LOOPER, 1 * MB);
      expect(await putTo(a.uploadUrl)).toBe(200);
      await release(LOOPER, a.key).expect(200);
      expect(await putTo(a.uploadUrl)).toBe(200);
      const b = await presign(OUTAGE, 1 * MB);
      expect(await putTo(b.uploadUrl)).toBe(200);
      await release(OUTAGE, b.key).expect(200);
      expect(await putTo(b.uploadUrl)).toBe(200);
      await age(a.key, 20);
      await age(b.key, 20);

      await timer.sweep();
      expect(stored.has(a.key)).toBe(false);
      expect(stored.has(b.key)).toBe(false);
      expect((await rowFor(a.key)).sweptRemovedAt).not.toBeNull();

      // A failing bucket is logged, never thrown out of the timer.
      headDown = true;
      await expect(timer.sweep()).resolves.toBeUndefined();
    });
  });

  describe('POST /uploads/confirm on a row the person released', () => {
    it('leaves it released when the late file lands: no recount, the file stays for the sweep', async () => {
      const before = await usedBytes(CONFIRMER);
      const p = await presign(CONFIRMER, 30 * MB);
      expect(await putTo(p.uploadUrl)).toBe(200);
      expect(await usedBytes(CONFIRMER)).toBe(before + 30 * MB);
      await release(CONFIRMER, p.key).expect(200);
      expect(await usedBytes(CONFIRMER)).toBe(before);

      // The late file lands through the link that is still valid, and the app
      // (or anyone with the token) confirms.
      expect(await putTo(p.uploadUrl)).toBe(200);
      for (const body of [p.key, p.fileUrl]) {
        const res = await confirm(CONFIRMER, body).expect(200);
        expect(dataOf(res)).toEqual({ key: p.key, status: 'abandoned' });
        expect(await usedBytes(CONFIRMER)).toBe(before);
      }
      const row = await rowFor(p.key);
      expect(row.status).toBe('abandoned');
      expect(row.confirmedAt).toBeNull();
      expect(row.releasedAt).not.toBeNull();

      // The sweep then removes the file.
      await age(p.key, 16);
      await storage.sweepLateFiles(CONFIRMER);
      expect(stored.has(p.key)).toBe(false);
      expect(await usedBytes(CONFIRMER)).toBe(before);
    });

    it('answers the same when the bucket is down: the row decides, not the bucket', async () => {
      const p = await presign(CONFIRMER, 2 * MB);
      await release(CONFIRMER, p.key).expect(200);
      headDown = true;
      const res = await confirm(CONFIRMER, p.key).expect(200);
      expect(dataOf(res)).toEqual({ key: p.key, status: 'abandoned' });
    });

    it('marks a row released even when it was already given up on, so a later file is not counted', async () => {
      const before = await usedBytes(CONFIRMER);
      const p = await presign(CONFIRMER, 9 * MB);
      await age(p.key, 7);
      expect(dataOf(await confirm(CONFIRMER, p.key))).toEqual({
        key: p.key,
        status: 'abandoned',
      });
      await release(CONFIRMER, p.key).expect(200);
      expect((await rowFor(p.key)).releasedAt).not.toBeNull();

      expect(await putTo(p.uploadUrl)).toBe(200);
      expect(dataOf(await confirm(CONFIRMER, p.key))).toEqual({
        key: p.key,
        status: 'abandoned',
      });
      expect(await usedBytes(CONFIRMER)).toBe(before);
    });

    it('still counts a file that was given up on but never released, as before', async () => {
      const before = await usedBytes(CONFIRMER);
      const p = await presign(CONFIRMER, 8 * MB);
      await age(p.key, 7);
      expect(dataOf(await confirm(CONFIRMER, p.key))).toEqual({
        key: p.key,
        status: 'abandoned',
      });
      expect(await putTo(p.uploadUrl)).toBe(200);
      expect(dataOf(await confirm(CONFIRMER, p.key))).toEqual({
        key: p.key,
        status: 'confirmed',
      });
      expect(await usedBytes(CONFIRMER)).toBe(before + 8 * MB);
    });
  });
});
