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
import { lockStorageQuota } from '../storage-lock';

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
/** Looks at a row again an hour and a day after the first. */
const LOOKER = OWN(7);
/** Two sweeps at once, a listing created while one waits, release against confirm. */
const RACER = OWN(8);
const OWNED = [
  LOOPER,
  CONFIRMER,
  CLAIMER,
  OUTAGE,
  BYSTANDER,
  OTHERS,
  LOOKER,
  RACER,
];
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
    // The Hub's real 10-minute timer is not this spec's (FIX-75): a tick that the
    // wall clock lands inside a test would sweep, or make timer.sweep() skip, at a
    // moment no test chose. The job stays registered (a test below checks it); its
    // sweeps here are driven by the spec through timer.sweep().
    await registry.getCronJob('sweep-late-uploads').stop();
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
    // Since TIER-02 (R-43) only a person who may publish is signed a file for
    // content: each person here holds a running tier.
    await prisma.makerTier.deleteMany({
      where: { wawuUserId: { in: OWNED } },
    });
    await prisma.makerTier.createMany({
      data: OWNED.map((wawuUserId) => ({
        wawuUserId,
        tierId: 'me04-suite',
        activeFrom: new Date(Date.now() - 86_400_000),
        activeUntil: new Date(Date.now() + 30 * 86_400_000),
        productsIncluded: 30,
        pointsIncluded: 0,
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
      expect(result).toEqual({ settled: 0, removed: 0, counted: 0, left: 0 });
      for (const key of keys) expect(stored.has(key)).toBe(true);

      // Past the link's life plus the margin (15 minutes) the files go.
      for (const key of keys) await age(key, 16);
      deletesSeen.length = 0;
      result = await storage.sweepLateFiles(LOOPER);
      expect(result).toEqual({ settled: 3, removed: 3, counted: 0, left: 0 });
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
        counted: 0,
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
      expect(result).toEqual({ settled: 1, removed: 0, counted: 0, left: 0 });
      expect(deletesSeen).toEqual([]);
      const row = await rowFor(p.key);
      expect(row.sweptAt).not.toBeNull();
      expect(row.sweptRemovedAt).toBeNull();
    });

    it('counts, and never deletes, the late file of an upload that was given up on but never released', async () => {
      const before = await usedBytes(OTHERS);
      const p = await presign(OTHERS, 6 * MB);
      // The app confirms past the link's life with nothing there: given up on.
      await age(p.key, 7);
      expect(dataOf(await confirm(OTHERS, p.key))).toEqual({
        key: p.key,
        status: 'abandoned',
      });
      expect((await rowFor(p.key)).releasedAt).toBeNull();
      expect(await usedBytes(OTHERS)).toBe(before);
      // A slow upload then lands, and nobody confirms it.
      expect(await putTo(p.uploadUrl)).toBe(200);
      await age(p.key, 16);

      deletesSeen.length = 0;
      const result = await storage.sweepLateFiles(OTHERS);
      expect(result).toEqual({ settled: 1, removed: 0, counted: 1, left: 0 });
      expect(deletesSeen).toEqual([]);
      expect(stored.has(p.key)).toBe(true);
      const row = await rowFor(p.key);
      expect(row.status).toBe('confirmed');
      expect(row.confirmedAt).not.toBeNull();
      expect(row.releasedAt).toBeNull();
      expect(row.sweptRemovedAt).toBeNull();
      expect(await usedBytes(OTHERS)).toBe(before + 6 * MB);
      // Counted once: the next pass has nothing to do, and a confirm agrees.
      expect(await storage.sweepLateFiles(OTHERS)).toEqual({
        settled: 0,
        removed: 0,
        counted: 0,
        left: 0,
      });
      expect(dataOf(await confirm(OTHERS, p.key))).toEqual({
        key: p.key,
        status: 'confirmed',
      });
    });

    describe('a key a listing uses', () => {
      /** A listing that names the file (a row the API no longer lets exist for a released file). */
      const claim = (sub: string, slug: string, fileUrl: string) =>
        prisma.contentPiece.create({
          data: {
            slug,
            creatorWawuId: sub,
            contentType: 'video',
            title: 'Claimed',
            description: 'Fixture',
            category: 'business_entrepreneurship',
            accessType: 'free',
            price: 0,
            previewAssetUrl: 'https://cdn.example.com/p.jpg',
            fullAssetUrl: fileUrl,
            status: 'pending',
          },
        });

      it('is never deleted: a released file a listing uses is counted and logged once', async () => {
        const warn = jest.spyOn(Logger.prototype, 'warn');
        const before = await usedBytes(CLAIMER);
        const p = await presign(CLAIMER, 4 * MB);
        expect(await putTo(p.uploadUrl)).toBe(200);
        await release(CLAIMER, p.key).expect(200);
        expect(await putTo(p.uploadUrl)).toBe(200);
        const piece = await claim(CLAIMER, 'me04-r4-claimed', p.fileUrl);
        await age(p.key, 30);

        deletesSeen.length = 0;
        warn.mockClear();
        const result = await storage.sweepLateFiles(CLAIMER);
        expect(result).toEqual({ settled: 1, removed: 0, counted: 1, left: 0 });
        expect(stored.has(p.key)).toBe(true);
        expect(deletesSeen).toEqual([]);
        const row = await rowFor(p.key);
        expect(row.status).toBe('confirmed');
        expect(row.sweptRemovedAt).toBeNull();
        expect(await usedBytes(CLAIMER)).toBe(before + 4 * MB);
        const logged = warn.mock.calls.filter((c) =>
          String(c[0]).includes('a listing uses it'),
        );
        expect(logged).toHaveLength(1);

        // Counted once, logged once.
        warn.mockClear();
        expect(await storage.sweepLateFiles(CLAIMER)).toEqual({
          settled: 0,
          removed: 0,
          counted: 0,
          left: 0,
        });
        expect(warn).not.toHaveBeenCalled();
        warn.mockRestore();
        await prisma.contentPiece.delete({ where: { id: piece.id } });
      });

      it('is counted when the person never released it, too', async () => {
        const before = await usedBytes(CLAIMER);
        const p = await presign(CLAIMER, 3 * MB);
        await age(p.key, 7);
        expect(dataOf(await confirm(CLAIMER, p.key))).toEqual({
          key: p.key,
          status: 'abandoned',
        });
        expect(await putTo(p.uploadUrl)).toBe(200);
        const piece = await claim(CLAIMER, 'me04-r4-claimed-b', p.fileUrl);
        await age(p.key, 30);

        const result = await storage.sweepLateFiles(CLAIMER);
        expect(result).toEqual({ settled: 1, removed: 0, counted: 1, left: 0 });
        expect(stored.has(p.key)).toBe(true);
        expect((await rowFor(p.key)).status).toBe('confirmed');
        expect(await usedBytes(CLAIMER)).toBe(before + 3 * MB);
        await prisma.contentPiece.delete({ where: { id: piece.id } });
      });
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
        counted: 0,
        left: 1,
      });
      expect(stored.has(p.key)).toBe(true);
      expect((await rowFor(p.key)).sweptAt).toBeNull();

      headDown = false;
      deleteRefused = true;
      expect(await storage.sweepLateFiles(OUTAGE)).toEqual({
        settled: 0,
        removed: 0,
        counted: 0,
        left: 1,
      });
      expect(stored.has(p.key)).toBe(true);
      expect((await rowFor(p.key)).sweptAt).toBeNull();

      deleteRefused = false;
      expect(await storage.sweepLateFiles(OUTAGE)).toEqual({
        settled: 1,
        removed: 1,
        counted: 0,
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
        counted: 0,
        left: 0,
      });
      expect(stored.has(mine.key)).toBe(true);

      const result = await storage.sweepLateFiles(BYSTANDER);
      expect(result).toEqual({ settled: 1, removed: 1, counted: 0, left: 0 });
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

  describe('round 4: the sweep looks again, and settles under the person’s lock', () => {
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms));
    /** Moves the sweep's first look back by `minutes`, as time passing would. */
    const lookedMinutesAgo = (key: string, minutes: number) =>
      prisma.storageObject.update({
        where: { key },
        data: { sweptAt: new Date(Date.now() - minutes * 60 * 1000) },
      });

    it('looks at a row with no file again an hour after the first look and a day after it, then never', async () => {
      const p = await presign(LOOKER, 5 * MB);
      expect(await putTo(p.uploadUrl)).toBe(200);
      await release(LOOKER, p.key).expect(200);
      await age(p.key, 16);

      // First look: no file. Recorded, nothing deleted.
      const zero = { settled: 0, removed: 0, counted: 0, left: 0 };
      expect(await storage.sweepLateFiles(LOOKER)).toEqual({
        ...zero,
        settled: 1,
      });
      let row = await rowFor(p.key);
      expect(row.sweptAt).not.toBeNull();
      expect(row.sweptHourAt).toBeNull();
      expect(row.sweptDayAt).toBeNull();

      // Half an hour on, no look is due.
      await lookedMinutesAgo(p.key, 30);
      expect(await storage.sweepLateFiles(LOOKER)).toEqual(zero);

      // An hour on: the second look, again no file; recorded.
      await lookedMinutesAgo(p.key, 61);
      deletesSeen.length = 0;
      expect(await storage.sweepLateFiles(LOOKER)).toEqual({
        ...zero,
        settled: 1,
      });
      row = await rowFor(p.key);
      expect(row.sweptHourAt).not.toBeNull();
      expect(row.sweptDayAt).toBeNull();
      expect(deletesSeen).toEqual([]);
      // Not again until the day look is due.
      expect(await storage.sweepLateFiles(LOOKER)).toEqual(zero);

      // The very late file lands. A day on: the third look finds it, and as
      // the person released it, deletes it.
      expect(await putTo(p.uploadUrl)).toBe(200);
      await lookedMinutesAgo(p.key, 24 * 60 + 5);
      expect(await storage.sweepLateFiles(LOOKER)).toEqual({
        ...zero,
        settled: 1,
        removed: 1,
      });
      expect(stored.has(p.key)).toBe(false);
      row = await rowFor(p.key);
      expect(row.sweptDayAt).not.toBeNull();
      expect(row.sweptRemovedAt).not.toBeNull();
      expect(await storage.sweepLateFiles(LOOKER)).toEqual(zero);
    });

    it('counts a never-released file found at the second look', async () => {
      const before = await usedBytes(LOOKER);
      const p = await presign(LOOKER, 7 * MB);
      await age(p.key, 7);
      expect(dataOf(await confirm(LOOKER, p.key))).toEqual({
        key: p.key,
        status: 'abandoned',
      });
      await age(p.key, 16);
      expect(await storage.sweepLateFiles(LOOKER)).toMatchObject({
        settled: 1,
        counted: 0,
      });
      // The upload that was still running lands after the first look.
      expect(await putTo(p.uploadUrl)).toBe(200);
      expect(await usedBytes(LOOKER)).toBe(before);
      await lookedMinutesAgo(p.key, 61);

      expect(await storage.sweepLateFiles(LOOKER)).toEqual({
        settled: 1,
        removed: 0,
        counted: 1,
        left: 0,
      });
      expect(stored.has(p.key)).toBe(true);
      const row = await rowFor(p.key);
      expect(row.status).toBe('confirmed');
      expect(row.sweptHourAt).not.toBeNull();
      expect(await usedBytes(LOOKER)).toBe(before + 7 * MB);
    });

    it('stops after the third look: a file that lands later is not seen', async () => {
      const p = await presign(LOOKER, 2 * MB);
      expect(await putTo(p.uploadUrl)).toBe(200);
      await release(LOOKER, p.key).expect(200);
      await age(p.key, 16);
      await storage.sweepLateFiles(LOOKER);
      await lookedMinutesAgo(p.key, 61);
      await storage.sweepLateFiles(LOOKER);
      await lookedMinutesAgo(p.key, 24 * 60 + 5);
      await storage.sweepLateFiles(LOOKER);
      const row = await rowFor(p.key);
      expect(row.sweptAt).not.toBeNull();
      expect(row.sweptHourAt).not.toBeNull();
      expect(row.sweptDayAt).not.toBeNull();

      expect(await putTo(p.uploadUrl)).toBe(200);
      await lookedMinutesAgo(p.key, 72 * 60);
      expect(await storage.sweepLateFiles(LOOKER)).toEqual({
        settled: 0,
        removed: 0,
        counted: 0,
        left: 0,
      });
      expect(stored.has(p.key)).toBe(true);
    });

    it('two sweeps at once settle a row once: the removal is logged and counted once', async () => {
      const keys: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        const p = await presign(RACER, 1 * MB);
        expect(await putTo(p.uploadUrl)).toBe(200);
        await release(RACER, p.key).expect(200);
        expect(await putTo(p.uploadUrl)).toBe(200);
        await age(p.key, 16);
        keys.push(p.key);
      }
      deletesSeen.length = 0;
      const [a, b] = await Promise.all([
        storage.sweepLateFiles(RACER),
        storage.sweepLateFiles(RACER),
      ]);
      expect(a.removed + b.removed).toBe(4);
      expect(a.settled + b.settled).toBe(4);
      expect(a.left + b.left).toBe(0);
      expect(deletesSeen.sort()).toEqual([...keys].sort());
      for (const key of keys) expect(stored.has(key)).toBe(false);
    });

    it('re-checks that no listing uses the key inside the lock: a listing created while the sweep waits keeps its files', async () => {
      const p = await presign(RACER, 2 * MB);
      expect(await putTo(p.uploadUrl)).toBe(200);
      await release(RACER, p.key).expect(200);
      expect(await putTo(p.uploadUrl)).toBe(200);
      await age(p.key, 16);

      // A create holds the person's lock, names the file, and commits after
      // the sweep has already found the file in the bucket.
      let letGo: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        letGo = resolve;
      });
      let locked: () => void = () => undefined;
      const isLocked = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const creating = prisma.$transaction(
        async (tx) => {
          await lockStorageQuota(tx, RACER);
          locked();
          await held;
          return tx.contentPiece.create({
            data: {
              slug: 'me04-r4-race',
              creatorWawuId: RACER,
              contentType: 'video',
              title: 'Named during the sweep',
              description: 'Fixture',
              category: 'business_entrepreneurship',
              accessType: 'free',
              price: 0,
              previewAssetUrl: 'https://cdn.example.com/p.jpg',
              fullAssetUrl: p.fileUrl,
              status: 'pending',
            },
          });
        },
        { timeout: 20_000 },
      );
      await isLocked;
      deletesSeen.length = 0;
      const sweeping = storage.sweepLateFiles(RACER);
      await sleep(600);
      // The sweep has asked the bucket and is waiting for the lock: it has
      // deleted nothing.
      expect(deletesSeen).toEqual([]);
      letGo();
      const piece = await creating;
      const result = await sweeping;

      expect(result).toEqual({ settled: 1, removed: 0, counted: 1, left: 0 });
      expect(stored.has(p.key)).toBe(true);
      expect(deletesSeen).toEqual([]);
      await prisma.contentPiece.delete({ where: { id: piece.id } });
    });

    /** Holds the person's storage lock until `letGo` is called. */
    async function holdLock(sub: string) {
      let letGo: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        letGo = resolve;
      });
      let locked: () => void = () => undefined;
      const isLocked = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const done = prisma.$transaction(
        async (tx) => {
          await lockStorageQuota(tx, sub);
          locked();
          await held;
        },
        { timeout: 20_000 },
      );
      await isLocked;
      return { letGo, done };
    }

    it('a release and a confirm both take the person’s lock: neither finishes while another step holds it', async () => {
      const p = await presign(RACER, 1000);
      expect(await putTo(p.uploadUrl)).toBe(200);
      const lock = await holdLock(RACER);
      deletesSeen.length = 0;

      let confirmed = false;
      let released = false;
      const confirming = confirm(RACER, p.key).then((res) => {
        confirmed = true;
        return res;
      });
      const releasing = release(RACER, p.key).then((res) => {
        released = true;
        return res;
      });
      await sleep(600);
      expect(confirmed).toBe(false);
      expect(released).toBe(false);
      expect(deletesSeen).toEqual([]);

      lock.letGo();
      await lock.done;
      expect((await confirming).status).toBe(200);
      expect((await releasing).status).toBe(200);
      // One after the other, in whichever order: never counted with no file.
      const row = await rowFor(p.key);
      expect(row.status).toBe('abandoned');
      expect(row.releasedAt).not.toBeNull();
      expect(stored.has(p.key)).toBe(false);
    });

    it('a release and a confirm sent together never leave a counted row with no file', async () => {
      const bad: string[] = [];
      for (let i = 0; i < 20; i += 1) {
        const p = await presign(RACER, 1000);
        // Odd rounds: the row was given up as missing (the re-adopt step).
        if (i % 2 === 1) {
          await prisma.storageObject.update({
            where: { key: p.key },
            data: { status: 'abandoned' },
          });
        }
        expect(await putTo(p.uploadUrl)).toBe(200);
        await Promise.all([release(RACER, p.key), confirm(RACER, p.key)]);
        const row = await rowFor(p.key);
        const counted = row.status === 'confirmed';
        // Either the release won (given up, file gone) or the confirm won and
        // the release then took the file away: never counted with no file.
        if (counted && !stored.has(p.key)) bad.push(p.key);
        if (counted && row.releasedAt) bad.push(p.key);
        if (!counted && row.releasedAt && stored.has(p.key)) bad.push(p.key);
      }
      expect(bad).toEqual([]);
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
