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
import { ContentPieceModule } from '../../content-piece/content-piece.module';
import { StorageModule } from '../storage.module';
import { StorageService } from '../storage.service';
import { StorageSweepService } from '../storage-sweep.service';
import { lockStorageQuota } from '../storage-lock';

/**
 * ME-04 round 5 over HTTP, on the real database and the real S3 client: the
 * Hub never holds a database transaction, a pooled connection or the person's
 * storage lock across a call to the bucket.
 *
 * Round 4 released a file, and the sweep removed one, inside a transaction that
 * held the person's lock across the bucket DELETE. A slow bucket then made the
 * same person's confirm answer 500 after 5 s, and a burst of releases held the
 * whole connection pool, so another person's request stalled for 14 s. Now a
 * release and a sweep removal are three steps (mark under the lock, delete
 * holding nothing, record under the lock), the confirm transaction waits like
 * the others, the bucket client has a request timeout, the sweep timer does not
 * overlap itself, and photo-set frames are checked under the same lock as a
 * listing.
 *
 * The bucket is a small S3-style server on this machine's loopback; it can
 * answer a DELETE late, never, or with an error. Every row is this spec's own
 * and is deleted in afterAll.
 */
const MB = 1024 * 1024;
const OWN = (n: number) =>
  `e0450000-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** Releases one file at a time and in bursts, and probes its own lock. */
const RELEASER = OWN(1);
/** Another person, who must never wait on the releaser. */
const BYSTANDER = OWN(2);
/** The sweep's removals. */
const SWEEPER = OWN(3);
/** Photo-set frames. */
const FRAMER = OWN(4);
/** A bucket that never answers. */
const HUNG = OWN(5);
/** A confirm that waits for the lock for longer than Prisma's default. */
const CONFIRMER = OWN(6);
const OWNED = [RELEASER, BYSTANDER, SWEEPER, FRAMER, HUNG, CONFIRMER];
const BUCKET = 'me04-r5-bucket';
const GIVEN_UP =
  'One of these files was released or never arrived. Upload it again.';
const TRY_AGAIN =
  'Could not remove that file right now. Try again in a moment.';

describe('Removing a file never holds the lock or a connection across the bucket (ME-04 round 5, contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let storage: StorageService;
  let timer: StorageSweepService;
  let privateKey: string;
  let publicKey: string;
  let host: http.Server;
  const envSnapshot: Record<string, string | undefined> = {};
  // Some cases wait out a bucket that never answers (two tries of 3 s).
  jest.setTimeout(90_000);

  /** What the storage host holds, and how it behaves right now. */
  const stored = new Set<string>();
  let deleteDelayMs = 0;
  let deleteHangs = false;
  let deleteRefused = false;
  let headHangs = false;
  const deletesSeen: string[] = [];

  const server = (): App => app.getHttpServer() as App;
  const dataOf = <T>(res: { body: unknown }) => (res.body as { data: T }).data;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
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
        if (deleteHangs) return; // never answers
        const answer = () => {
          if (deleteRefused) {
            res.statusCode = 500;
            res.end();
            return;
          }
          deletesSeen.push(key);
          stored.delete(key);
          res.statusCode = 204;
          res.end();
        };
        if (deleteDelayMs > 0) setTimeout(answer, deleteDelayMs);
        else answer();
        return;
      }
      if (req.method === 'HEAD') {
        if (headHangs) return;
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

  async function presign(
    sub: string,
    bytes = MB,
    format: 'pdf' | 'image' = 'pdf',
    folder: 'content/full' | 'content/preview' = 'content/full',
  ) {
    const res = await request(server())
      .post('/uploads/presign')
      .set('Authorization', bearer(sub))
      .send({
        folder,
        format,
        contentType: format === 'pdf' ? 'application/pdf' : 'image/png',
        extension: format === 'pdf' ? 'pdf' : 'png',
        contentLength: bytes,
      })
      .expect(200);
    return dataOf<{ key: string; fileUrl: string; uploadUrl: string }>(res);
  }

  /** Reserve and send, as the app does. */
  async function upload(sub: string, bytes = MB) {
    const p = await presign(sub, bytes);
    const put = await fetch(p.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/pdf' },
      body: Buffer.alloc(1),
    });
    expect(put.status).toBe(200);
    return p;
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

  const allowance = (sub: string) =>
    request(server())
      .get('/uploads/allowance')
      .set('Authorization', bearer(sub));

  async function usedBytes(sub: string): Promise<number> {
    const res = await allowance(sub).expect(200);
    return dataOf<{ storage: { usedBytes: number } }>(res).storage.usedBytes;
  }

  const listing = (previewAsset: string, fullAsset: string) => ({
    contentType: 'pdf',
    title: 'ME-04 round 5',
    description: 'A piece that names two uploads',
    category: 'business_entrepreneurship',
    tags: [],
    accessType: 'paid',
    price: 2000,
    previewAsset,
    fullAsset,
  });
  const post = (sub: string, previewAsset: string, fullAsset: string) =>
    request(server())
      .post('/content')
      .set('Authorization', bearer(sub))
      .send(listing(previewAsset, fullAsset));

  const rowFor = (key: string) =>
    prisma.storageObject.findUniqueOrThrow({ where: { key } });

  /** Moves a reservation's presign time back by `minutes`. */
  const age = (key: string, minutes: number) =>
    prisma.storageObject.update({
      where: { key },
      data: { createdAt: new Date(Date.now() - minutes * 60 * 1000) },
    });

  /** How long it takes this person's lock to be granted, in ms. */
  async function lockWait(sub: string): Promise<number> {
    const t0 = Date.now();
    await prisma.$transaction((tx) => lockStorageQuota(tx, sub));
    return Date.now() - t0;
  }

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
      { timeout: 30_000 },
    );
    await isLocked;
    return { letGo, done };
  }

  beforeAll(async () => {
    const port = await startHost();
    const env: Record<string, string> = {
      STORAGE_ENDPOINT: `http://127.0.0.1:${port}`,
      STORAGE_ACCESS_KEY_ID: 'me04-r5-key',
      STORAGE_SECRET_ACCESS_KEY: 'me04-r5-secret',
      STORAGE_BUCKET: BUCKET,
      STORAGE_REGION: 'auto',
      STORAGE_FORCE_PATH_STYLE: 'true',
      // Short, so the spec can prove that a bucket which never answers is cut off.
      STORAGE_REQUEST_TIMEOUT_MS: '3000',
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
        ContentPieceModule,
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
    // The Hub's real 10-minute timer is not this spec's. ScheduleModule arms it
    // on the wall clock (:00, :10, :20 ...), and a tick that lands inside a test
    // window adds its own "skipped" line to the warn spy (or sweeps the shared
    // bucket) at a moment no test chose (FIX-75). Every sweep here is driven by
    // the spec through timer.sweep(), which is the body the timer calls; the job
    // stays registered, only its wall-clock firing is stopped.
    await moduleRef
      .get(SchedulerRegistry)
      .getCronJob('sweep-late-uploads')
      .stop();
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
    host?.closeAllConnections();
    await new Promise<void>((resolve) => host?.close(() => resolve()));
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(() => {
    deleteDelayMs = 0;
    deleteHangs = false;
    deleteRefused = false;
    headHangs = false;
    deletesSeen.length = 0;
  });

  describe('a release', () => {
    it('holds neither the lock nor a connection while the bucket deletes: the same person goes on, and the key is refused meanwhile', async () => {
      const slow = await upload(RELEASER);
      const spare = await upload(RELEASER);
      const pv = await presign(RELEASER, MB, 'pdf', 'content/preview');
      const fl = await presign(RELEASER);
      deleteDelayMs = 2000;

      const started = Date.now();
      const releasing = release(RELEASER, slow.key).then((res) => ({
        status: res.status,
        at: Date.now() - started,
      }));
      await sleep(600);
      // Marked under the lock, committed, and now only the bucket is busy.
      const marked = await rowFor(slow.key);
      expect(marked.status).toBe('abandoned');
      expect(marked.releasedAt).not.toBeNull();
      expect(marked.removingAt).not.toBeNull();

      // The lock is free: a step that needs it is granted it at once.
      expect(await lockWait(RELEASER)).toBeLessThan(500);

      // Another file of the same person confirms (the old code answered 500
      // after 5 s), lists and releases without waiting.
      deleteDelayMs = 0;
      const t0 = Date.now();
      const settled = await confirm(RELEASER, spare.key);
      expect(settled.status).toBe(200);
      expect(Date.now() - t0).toBeLessThan(1500);
      const made = await post(RELEASER, pv.fileUrl, fl.fileUrl);
      expect(made.status).toBe(201);
      deleteDelayMs = 2000;

      // The file being removed cannot be claimed or counted again.
      const again = await confirm(RELEASER, slow.key);
      expect(again.status).toBe(200);
      expect(dataOf<{ status: string }>(again).status).toBe('abandoned');
      const refused = await post(RELEASER, slow.fileUrl, fl.fileUrl);
      expect(refused.status).toBe(400);
      expect((refused.body as { message: string }).message).toBe(GIVEN_UP);
      const twice = await release(RELEASER, slow.key);
      expect(twice.status).toBe(503);
      expect((twice.body as { message: string }).message).toBe(TRY_AGAIN);

      const done = await releasing;
      expect(done.status).toBe(200);
      expect(done.at).toBeGreaterThanOrEqual(1900);
      const row = await rowFor(slow.key);
      expect(row.status).toBe('abandoned');
      expect(row.releasedAt).not.toBeNull();
      expect(row.removingAt).toBeNull();
      expect(stored.has(slow.key)).toBe(false);
      // The released file is not counted; the two the listing uses are.
      expect(await usedBytes(RELEASER)).toBe(await sumCounted(RELEASER));
    });

    /** What the rows say is counted (pending and confirmed). */
    async function sumCounted(sub: string): Promise<number> {
      const rows = await prisma.storageObject.findMany({
        where: {
          wawuUserId: sub,
          status: { in: ['pending', 'confirmed'] },
          folder: { in: ['content/full', 'content/preview'] },
        },
        select: { bytes: true },
      });
      return rows.reduce((a, r) => a + r.bytes, 0);
    }

    it("a burst of one person's releases holds no connection: another person is not slowed and nobody gets a 500", async () => {
      const keys: string[] = [];
      for (let i = 0; i < 14; i += 1)
        keys.push((await upload(RELEASER, 1000)).key);
      deleteDelayMs = 1200;

      const burst = Promise.all(keys.map((key) => release(RELEASER, key)));
      await sleep(300);
      const probes: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        const t0 = Date.now();
        await allowance(BYSTANDER).expect(200);
        probes.push(Date.now() - t0);
        await sleep(150);
      }
      const results = await burst;
      // Round 6: a person's requests take their turn in memory, two may wait
      // and the rest are refused 429 with a Retry-After at once, so what a
      // burst answers is 200 (done) or 429 (not started), never a 500.
      const statuses = results.map((r) => r.status);
      for (const status of statuses) expect([200, 429]).toContain(status);
      expect(statuses).toContain(200);
      expect(Math.max(...probes)).toBeLessThan(1000);
      for (const [i, key] of keys.entries()) {
        const row = await rowFor(key);
        expect(row.removingAt).toBeNull();
        if (statuses[i] === 200) {
          expect(row.releasedAt).not.toBeNull();
          expect(stored.has(key)).toBe(false);
        } else {
          // Refused before anything was touched: still reserved and in the bucket.
          expect(results[i].headers['retry-after']).toBe('1');
          expect(row.status).toBe('pending');
          expect(row.releasedAt).toBeNull();
          expect(stored.has(key)).toBe(true);
        }
      }
    });

    it('puts the row back as it was when the bucket refuses the delete: counted, claimable, and a retry works', async () => {
      const p = await upload(RELEASER);
      const before = await usedBytes(RELEASER);
      deleteRefused = true;
      const res = await release(RELEASER, p.key);
      expect(res.status).toBe(503);
      expect((res.body as { message: string }).message).toBe(TRY_AGAIN);
      const row = await rowFor(p.key);
      expect(row.status).toBe('pending');
      expect(row.releasedAt).toBeNull();
      expect(row.removingAt).toBeNull();
      expect(stored.has(p.key)).toBe(true);
      expect(await usedBytes(RELEASER)).toBe(before);

      deleteRefused = false;
      await release(RELEASER, p.key).expect(200);
      expect(stored.has(p.key)).toBe(false);
      expect(await usedBytes(RELEASER)).toBe(before - MB);
    });

    it('never hands the key to anyone when the bucket does not answer: the call is cut off at the request timeout, the row stays given up, and the sweep finishes it', async () => {
      const p = await upload(HUNG);
      deleteHangs = true;
      const t0 = Date.now();
      const res = await release(HUNG, p.key);
      const took = Date.now() - t0;
      expect(res.status).toBe(503);
      expect((res.body as { message: string }).message).toBe(TRY_AGAIN);
      // Two tries of 3 s, not a call that waits for ever.
      expect(took).toBeGreaterThanOrEqual(5500);
      expect(took).toBeLessThan(12_000);

      const row = await rowFor(p.key);
      expect(row.status).toBe('abandoned');
      expect(row.releasedAt).not.toBeNull();
      expect(row.removingAt).toBeNull();
      expect(stored.has(p.key)).toBe(true);
      // Nothing can claim it while the delete may still land.
      const pv = await presign(HUNG, MB, 'pdf', 'content/preview');
      const made = await post(HUNG, pv.fileUrl, p.fileUrl);
      expect(made.status).toBe(400);

      deleteHangs = false;
      await age(p.key, 16);
      const result = await storage.sweepLateFiles(HUNG);
      expect(result).toEqual({ settled: 1, removed: 1, counted: 0, left: 0 });
      expect(stored.has(p.key)).toBe(false);
    });
  });

  describe('the sweep', () => {
    /** A released file that landed late: the row is old enough to be looked at. */
    async function lateFile(sub: string) {
      const p = await upload(sub);
      await release(sub, p.key).expect(200);
      const put = await fetch(p.uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': 'application/pdf' },
        body: Buffer.alloc(1),
      });
      expect(put.status).toBe(200);
      await age(p.key, 16);
      // The release's own delete is not the sweep's.
      deletesSeen.length = 0;
      return p;
    }

    it('holds neither the lock nor a connection while it deletes, and keeps every other step off the key', async () => {
      const late = await lateFile(SWEEPER);
      const other = await upload(SWEEPER);
      deleteDelayMs = 2000;

      const sweeping = storage.sweepLateFiles(SWEEPER);
      await sleep(700);
      const marked = await rowFor(late.key);
      expect(marked.removingAt).not.toBeNull();
      expect(marked.sweptRemovedAt).toBeNull();
      expect(await lockWait(SWEEPER)).toBeLessThan(500);
      deleteDelayMs = 0;
      const t0 = Date.now();
      expect((await confirm(SWEEPER, other.key)).status).toBe(200);
      expect(Date.now() - t0).toBeLessThan(1500);
      deleteDelayMs = 2000;
      const again = await confirm(SWEEPER, late.key);
      expect(dataOf<{ status: string }>(again).status).toBe('abandoned');

      expect(await sweeping).toEqual({
        settled: 1,
        removed: 1,
        counted: 0,
        left: 0,
      });
      const row = await rowFor(late.key);
      expect(row.removingAt).toBeNull();
      expect(row.sweptRemovedAt).not.toBeNull();
      expect(stored.has(late.key)).toBe(false);
    });

    it('two sweeps at once delete a file once: the second finds the first one’s mark', async () => {
      const late = await lateFile(SWEEPER);
      deleteDelayMs = 1500;
      const results = await Promise.all([
        storage.sweepLateFiles(SWEEPER),
        storage.sweepLateFiles(SWEEPER),
      ]);
      expect(deletesSeen.filter((k) => k === late.key)).toHaveLength(1);
      expect(results.reduce((n, r) => n + r.removed, 0)).toBe(1);
      expect(stored.has(late.key)).toBe(false);
    });

    it('clears its mark and leaves the row for the next pass when the delete is refused', async () => {
      const late = await lateFile(SWEEPER);
      deleteRefused = true;
      expect(await storage.sweepLateFiles(SWEEPER)).toEqual({
        settled: 0,
        removed: 0,
        counted: 0,
        left: 1,
      });
      const row = await rowFor(late.key);
      expect(row.removingAt).toBeNull();
      expect(row.sweptRemovedAt).toBeNull();
      expect(stored.has(late.key)).toBe(true);

      deleteRefused = false;
      expect((await storage.sweepLateFiles(SWEEPER)).removed).toBe(1);
      expect(stored.has(late.key)).toBe(false);
    });

    it('leaves a removal that is in flight alone, and takes over one that never finished', async () => {
      const late = await lateFile(SWEEPER);
      await prisma.storageObject.update({
        where: { key: late.key },
        data: { removingAt: new Date() },
      });
      expect(await storage.sweepLateFiles(SWEEPER)).toEqual({
        settled: 0,
        removed: 0,
        counted: 0,
        left: 0,
      });
      expect(stored.has(late.key)).toBe(true);
      expect(deletesSeen).toEqual([]);

      // The Hub stopped between the mark and the record, minutes ago.
      await prisma.storageObject.update({
        where: { key: late.key },
        data: { removingAt: new Date(Date.now() - 5 * 60 * 1000) },
      });
      expect((await storage.sweepLateFiles(SWEEPER)).removed).toBe(1);
      expect(stored.has(late.key)).toBe(false);
      expect((await rowFor(late.key)).removingAt).toBeNull();
    });

    it('a bucket that never answers a HEAD or a DELETE cannot hang a run', async () => {
      const late = await lateFile(HUNG);
      headHangs = true;
      const t0 = Date.now();
      const first = await storage.sweepLateFiles(HUNG);
      expect(first.left).toBe(1);
      expect(Date.now() - t0).toBeLessThan(14_000);

      headHangs = false;
      deleteHangs = true;
      const t1 = Date.now();
      const second = await storage.sweepLateFiles(HUNG);
      expect(second).toEqual({ settled: 0, removed: 0, counted: 0, left: 1 });
      expect(Date.now() - t1).toBeLessThan(14_000);
      expect((await rowFor(late.key)).removingAt).toBeNull();

      deleteHangs = false;
      expect((await storage.sweepLateFiles(HUNG)).removed).toBe(1);
    });

    it('the timer does not overlap itself: a tick that finds the last run going skips and says so', async () => {
      const late = await lateFile(SWEEPER);
      deleteDelayMs = 1500;
      const warn = jest.spyOn(Logger.prototype, 'warn');
      try {
        const first = timer.sweep();
        await sleep(300);
        await timer.sweep(); // returns at once: the first is still going
        const skipped = warn.mock.calls.filter((c) =>
          String(c[0]).includes('skipped'),
        );
        expect(skipped).toHaveLength(1);
        expect(deletesSeen).toEqual([]);
        await first;
        expect(deletesSeen).toEqual([late.key]);
        // After it ends, the next tick runs again.
        await timer.sweep();
        expect(
          warn.mock.calls.filter((c) => String(c[0]).includes('skipped')),
        ).toHaveLength(1);
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('a confirm', () => {
    it('waits for the person’s lock for longer than five seconds and then answers 200, not 500', async () => {
      const p = await upload(CONFIRMER);
      // A pending row whose file is in the bucket, given up on, so the confirm
      // has to re-adopt it inside the locked transaction.
      await prisma.storageObject.update({
        where: { key: p.key },
        data: { status: 'abandoned' },
      });
      const lock = await holdLock(CONFIRMER);
      const started = Date.now();
      const confirming = confirm(CONFIRMER, p.key);
      await sleep(6200);
      lock.letGo();
      await lock.done;
      const res = await confirming;
      expect(Date.now() - started).toBeGreaterThanOrEqual(6000);
      expect(res.status).toBe(200);
      expect(dataOf<{ status: string }>(res).status).toBe('confirmed');
    }, 30_000);
  });

  describe('photo-set frames', () => {
    let pieceId: string;

    beforeAll(async () => {
      const piece = await prisma.contentPiece.create({
        data: {
          slug: 'me04-r5-photo-set',
          creatorWawuId: FRAMER,
          contentType: 'image',
          title: 'A photo set',
          description: 'Fixture',
          category: 'business_entrepreneurship',
          accessType: 'free',
          price: 0,
          previewAssetUrl: 'https://cdn.example.com/p.jpg',
          fullAssetUrl: 'https://cdn.example.com/f.jpg',
          status: 'pending',
        },
      });
      pieceId = piece.id;
    });

    const setFrames = (frames: string[]) =>
      request(server())
        .put(`/content/${pieceId}/media`)
        .set('Authorization', bearer(FRAMER))
        .send({ frames });

    const framesOf = () =>
      prisma.contentFrame.findMany({ where: { contentId: pieceId } });

    it('are checked under the same lock as a listing: a frame set waits for a step that holds it, then sees what that step did', async () => {
      const p = await presign(FRAMER, MB, 'image');
      const lock = await holdLock(FRAMER);
      let answered = false;
      const setting = setFrames([p.key]).then((res) => {
        answered = true;
        return res;
      });
      await sleep(700);
      expect(answered).toBe(false);

      // While the frame set waits, the file is released and removed.
      await prisma.storageObject.update({
        where: { key: p.key },
        data: { status: 'abandoned', releasedAt: new Date() },
      });
      lock.letGo();
      await lock.done;
      const res = await setting;
      expect(res.status).toBe(400);
      expect(await framesOf()).toEqual([]);
    });

    it('are refused for a file being removed, and kept for a good one', async () => {
      const removing = await presign(FRAMER, MB, 'image');
      const good = await presign(FRAMER, MB, 'image');
      await prisma.storageObject.update({
        where: { key: removing.key },
        data: {
          status: 'abandoned',
          releasedAt: new Date(),
          removingAt: new Date(),
        },
      });
      expect((await setFrames([good.key, removing.key])).status).toBe(400);
      expect(await framesOf()).toEqual([]);
      expect((await setFrames([good.key])).status).toBe(200);
      expect((await framesOf()).map((f) => f.url)).toEqual([good.key]);
    });

    it('a release and a frame set sent together never leave a frame on a deleted file', async () => {
      const bad: string[] = [];
      for (let i = 0; i < 10; i += 1) {
        const p = await presign(FRAMER, 1000, 'image');
        const [freed, framed] = await Promise.all([
          release(FRAMER, p.key),
          setFrames([p.key]),
        ]);
        const frames = await framesOf();
        const framedNow = frames.some((f) => f.url === p.key);
        // Exactly one wins: the frame (and the release answers 409), or the
        // release (and the frame set answers 400).
        const frameWon = framed.status === 200;
        if (frameWon === (freed.status === 200)) {
          bad.push(`${framed.status}/${freed.status}`);
        }
        if (framedNow && stored.has(p.key) === false) bad.push(p.key);
        await setFrames([]);
      }
      expect(bad).toEqual([]);
    });
  });
});
