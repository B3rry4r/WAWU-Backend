// AITOOLS-08 (R-109): the Hub stores a picture or video it made itself from a
// STREAM (memory stays flat), serves it under a plain download name, and copies
// a Studio result into the person's own content folder as an upload counted like
// any upload. The bucket is a small S3-style server on this machine's loopback,
// spoken to by the AWS SDK over real HTTP; every row is this spec's own.

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import * as http from 'http';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'net';
import { Readable } from 'node:stream';
import { ConfigService } from '@nestjs/config';
import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StorageService } from '../storage.service';
import {
  publishingOver,
  publishingTables,
} from '../../plans/tests/publishing-fakes';
import { TierGateError } from '../../plans/tier-gate-error';

jest.setTimeout(120_000);

const OWNER = 'a1f08000-0000-4000-8000-000000000001';
const OTHER = 'a1f08000-0000-4000-8000-000000000002';
const BUCKET = 'ai08-bucket';
const MB = 1024 * 1024;

/** A stream of `n` bytes in 64 KB pieces, built as it is read: nothing holds the whole. */
const zeros = (n: number) =>
  Readable.from(
    (function* () {
      const piece = Buffer.alloc(64 * 1024, 1);
      for (let left = n; left > 0; left -= piece.length)
        yield left >= piece.length ? piece : piece.subarray(0, left);
    })(),
    { objectMode: false },
  );
const tempDirs = () =>
  readdirSync(tmpdir()).filter((n) => n.startsWith('wawu-gen-')).length;

describe('AITOOLS-08: a Studio result in storage (contract)', () => {
  let server: http.Server;
  let prisma: PrismaService;
  const objects = new Map<string, { bytes: number; type: string }>();
  const copies: { to: string; from: string }[] = [];
  let storage: StorageService;
  let world: Parameters<typeof publishingTables>[0];

  const build = (w: typeof world, port: number) => {
    const { allowance, gate } = publishingOver(publishingTables(w, OWNER));
    return new StorageService(
      new ConfigService({
        STORAGE_ENDPOINT: `http://127.0.0.1:${port}`,
        STORAGE_ACCESS_KEY_ID: 'k',
        STORAGE_SECRET_ACCESS_KEY: 's',
        STORAGE_BUCKET: BUCKET,
        STORAGE_FORCE_PATH_STYLE: 'true',
      }),
      prisma,
      allowance,
      gate,
    );
  };
  let port = 0;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const key = decodeURIComponent((req.url ?? '').split('?')[0]).replace(
        `/${BUCKET}/`,
        '',
      );
      let bytes = 0;
      req.on('data', (c: Buffer) => (bytes += c.length));
      req.on('end', () => {
        if (req.method === 'PUT') {
          const source = req.headers['x-amz-copy-source'];
          if (typeof source === 'string') {
            const from = decodeURIComponent(source).replace(`${BUCKET}/`, '');
            const held = objects.get(from);
            if (!held) {
              res.statusCode = 404;
              return res.end();
            }
            objects.set(key, { ...held });
            copies.push({ to: key, from });
            res.setHeader('content-type', 'application/xml');
            res.statusCode = 200;
            return res.end(
              '<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult><ETag>"x"</ETag><LastModified>2026-10-30T00:00:00.000Z</LastModified></CopyObjectResult>',
            );
          }
          objects.set(key, {
            bytes,
            type: String(req.headers['content-type'] ?? ''),
          });
          res.statusCode = 200;
        } else if (req.method === 'DELETE') {
          objects.delete(key);
          res.statusCode = 204;
        } else if (req.method === 'HEAD') {
          res.statusCode = objects.has(key) ? 200 : 404;
        } else res.statusCode = 404;
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as AddressInfo).port;
    prisma = new PrismaService();
    await prisma.$connect();
    world = { tier: { endsInDays: 30, productsIncluded: 5 }, slotsUsed: 0 };
    storage = build(world, port);
  });
  afterAll(async () => {
    await prisma.storageObject.deleteMany({
      where: { wawuUserId: { in: [OWNER, OTHER] } },
    });
    await prisma.$disconnect();
    await new Promise<void>((r) => server.close(() => r()));
  });
  beforeEach(async () => {
    await prisma.storageObject.deleteMany({
      where: { wawuUserId: { in: [OWNER, OTHER] } },
    });
    objects.clear();
    copies.length = 0;
    world = { tier: { endsInDays: 30, productsIncluded: 5 }, slotsUsed: 0 };
    storage = build(world, port);
  });

  describe('putGeneratedStream', () => {
    it("stores a stream as a confirmed object of the person in the tool's folder, outside every allowance", async () => {
      const before = tempDirs();
      const out = await storage.putGeneratedStream(
        OWNER,
        'ai/video',
        'job-1',
        zeros(3 * MB + 17),
        'video/mp4',
        10 * MB,
      );
      expect(out).toEqual({
        key: `ai/video/${OWNER}/job-1.mp4`,
        bytes: 3 * MB + 17,
      });
      expect(objects.get(out.key)).toEqual({
        bytes: 3 * MB + 17,
        type: 'video/mp4',
      });
      expect(
        await prisma.storageObject.findUnique({ where: { key: out.key } }),
      ).toMatchObject({
        wawuUserId: OWNER,
        folder: 'ai/video',
        contentType: 'video/mp4',
        bytes: 3 * MB + 17,
        status: 'confirmed',
      });
      // The R-7 allowance counts creator content only.
      expect((await storage.usageFor(OWNER)).usedBytes).toBe(0);
      expect(tempDirs()).toBe(before);
    });

    it("holds the Hub's memory flat for 300 MB (V8) and leaves no temporary file", async () => {
      const before = tempDirs();
      // A first small put warms the client up (its first use allocates its own buffers).
      await storage.putGeneratedStream(
        OWNER,
        'ai/video',
        'warm',
        zeros(2 * MB),
        'video/mp4',
        100 * MB,
      );
      const base = process.memoryUsage().rss;
      let peak = base;
      const timer = setInterval(() => {
        peak = Math.max(peak, process.memoryUsage().rss);
      }, 5);
      const out = await storage.putGeneratedStream(
        OWNER,
        'ai/video',
        'big',
        zeros(300 * MB),
        'video/mp4',
        400 * MB,
      );
      clearInterval(timer);
      const added = Math.round((peak - base) / MB);
      console.log(
        `300 MB stored from a stream: RSS +${added} MB over ${Math.round(base / MB)} MB`,
      );
      expect(out.bytes).toBe(300 * MB);
      // A whole-file read would add the 300 MB (and more): what stays is garbage not yet collected and the client's own buffers.
      expect(added).toBeLessThan(170);
      expect(tempDirs()).toBe(before);
    });

    it('refuses a stream over the cap, an empty one, a broken one, a type the Hub does not serve and a name that is not a plain name; nothing is stored and nothing is left behind', async () => {
      const before = tempDirs();
      await expect(
        storage.putGeneratedStream(
          OWNER,
          'ai/video',
          'a',
          zeros(2 * MB),
          'video/mp4',
          MB,
        ),
      ).rejects.toThrow(/too big/);
      await expect(
        storage.putGeneratedStream(
          OWNER,
          'ai/video',
          'b',
          Readable.from([], { objectMode: false }),
          'video/mp4',
          MB,
        ),
      ).rejects.toThrow(/empty/);
      const broken = new Readable({
        read() {
          this.push(Buffer.alloc(1000));
          this.destroy(new Error('connection lost'));
        },
      });
      await expect(
        storage.putGeneratedStream(
          OWNER,
          'ai/video',
          'c',
          broken,
          'video/mp4',
          MB,
        ),
      ).rejects.toBeDefined();
      await expect(
        storage.putGeneratedStream(
          OWNER,
          'ai/video',
          'd',
          zeros(10),
          'video/x-matroska',
          MB,
        ),
      ).rejects.toThrow(/does not serve/);
      await expect(
        storage.putGeneratedStream(
          OWNER,
          'ai/video',
          '../e',
          zeros(10),
          'video/mp4',
          MB,
        ),
      ).rejects.toThrow(/does not serve/);
      expect(objects.size).toBe(0);
      expect(
        await prisma.storageObject.count({ where: { wawuUserId: OWNER } }),
      ).toBe(0);
      expect(tempDirs()).toBe(before);
    });

    it('writing the same job again replaces the file and keeps one row', async () => {
      await storage.putGeneratedStream(
        OWNER,
        'ai/image',
        'j',
        zeros(100),
        'image/png',
        MB,
      );
      await storage.putGeneratedStream(
        OWNER,
        'ai/image',
        'j',
        zeros(250),
        'image/png',
        MB,
      );
      expect(
        await prisma.storageObject.count({ where: { wawuUserId: OWNER } }),
      ).toBe(1);
      expect(objects.get(`ai/image/${OWNER}/j.png`)!.bytes).toBe(250);
    });
  });

  describe('downloadUrlFor', () => {
    it('signs a link that saves the file as an attachment under a plain name', async () => {
      const link = new URL(
        await storage.downloadUrlFor(
          `ai/image/${OWNER}/j.png`,
          'studio-image-30-oct-2026.png',
        ),
      );
      expect(link.pathname).toContain(`ai/image/${OWNER}/j.png`);
      expect(link.searchParams.get('response-content-type')).toBe('image/png');
      expect(link.searchParams.get('response-content-disposition')).toBe(
        'attachment; filename="studio-image-30-oct-2026.png"',
      );
      // A name with anything else in it is cleaned to letters, digits, dots, dashes.
      const odd = new URL(
        await storage.downloadUrlFor(
          `ai/image/${OWNER}/j.png`,
          'a"b\r\nc d/é.png',
        ),
      );
      expect(odd.searchParams.get('response-content-disposition')).toMatch(
        /^attachment; filename="[A-Za-z0-9._-]+"$/,
      );
    });
  });

  describe('copyIntoContent', () => {
    const made = async (who = OWNER, bytes = 5 * MB) =>
      (
        await storage.putGeneratedStream(
          who,
          'ai/image',
          `r-${bytes}`,
          zeros(bytes),
          'image/png',
          100 * MB,
        )
      ).key;

    it('copies the result inside the bucket into content/full as a confirmed upload counted like any upload; the same seed finds the same copy', async () => {
      const source = await made();
      const first = await storage.copyIntoContent(OWNER, source, 'job-1:0');
      expect(first.replayed).toBe(false);
      expect(first.key).toMatch(
        new RegExp(
          `^content/full/${OWNER}/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.png$`,
        ),
      );
      expect(first).toMatchObject({ bytes: 5 * MB, contentType: 'image/png' });
      expect(new URL(first.fileUrl).pathname).toContain(first.key);
      // Copied in the bucket: the Hub sent no bytes.
      expect(copies).toEqual([{ to: first.key, from: source }]);
      expect(
        await prisma.storageObject.findUnique({ where: { key: first.key } }),
      ).toMatchObject({
        wawuUserId: OWNER,
        folder: 'content/full',
        status: 'confirmed',
        bytes: 5 * MB,
        contentType: 'image/png',
      });
      // Counted against the person's storage like any upload (R-7).
      expect((await storage.usageFor(OWNER)).usedBytes).toBe(5 * MB);
      // Again: one key, one copy.
      const again = await storage.copyIntoContent(OWNER, source, 'job-1:0');
      expect(again).toMatchObject({ key: first.key, replayed: true });
      expect(copies).toHaveLength(1);
      expect((await storage.usageFor(OWNER)).usedBytes).toBe(5 * MB);
      // Another output of the job is another copy.
      const other = await storage.copyIntoContent(OWNER, source, 'job-1:1');
      expect(other.key).not.toBe(first.key);
      expect((await storage.usageFor(OWNER)).usedBytes).toBe(10 * MB);
    });

    it('a row the person can publish: own, confirmed, not released, in the shape the presign writes (what POST /content checks)', async () => {
      const source = await made();
      const c = await storage.copyIntoContent(OWNER, source, 's');
      const row = await prisma.storageObject.findUniqueOrThrow({
        where: { key: c.key },
      });
      expect(row).toMatchObject({
        wawuUserId: OWNER,
        status: 'confirmed',
        releasedAt: null,
        removingAt: null,
      });
      expect(c.key.split('/')).toHaveLength(4);
    });

    it('refuses a person who may not publish with the tier answer, and one with no room with the storage answer; nothing is copied', async () => {
      const source = await made();
      world = { slotsUsed: 0 };
      const noTier = build(world, port);
      await expect(
        noTier.copyIntoContent(OWNER, source, 's'),
      ).rejects.toBeInstanceOf(TierGateError);
      expect(copies).toHaveLength(0);
      // A full account: 1 GB of content already.
      await prisma.storageObject.create({
        data: {
          wawuUserId: OWNER,
          key: `content/full/${OWNER}/full.mp4`,
          bytes: 1024 * MB - 2 * MB,
          contentType: 'video/mp4',
          folder: 'content/full',
          status: 'confirmed',
          confirmedAt: new Date(),
        },
      });
      const full = await storage
        .copyIntoContent(OWNER, source, 's')
        .catch((e: unknown) => e);
      expect((full as { getStatus: () => number }).getStatus()).toBe(413);
      expect(
        (
          full as { getResponse: () => { reason: { code: string } } }
        ).getResponse().reason.code,
      ).toBe('storage_limit_reached');
      expect(copies).toHaveLength(0);
      expect(
        await prisma.storageObject.count({
          where: { wawuUserId: OWNER, folder: 'content/full' },
        }),
      ).toBe(1);
    });

    it('releasing the copy gives the space back and the next call makes a new copy under a new key', async () => {
      const source = await made();
      const first = await storage.copyIntoContent(OWNER, source, 's');
      expect((await storage.usageFor(OWNER)).usedBytes).toBe(5 * MB);
      await storage.releaseUpload(OWNER, first.key);
      expect((await storage.usageFor(OWNER)).usedBytes).toBe(0);
      const second = await storage.copyIntoContent(OWNER, source, 's');
      expect(second.key).not.toBe(first.key);
      expect(second.replayed).toBe(false);
      expect((await storage.usageFor(OWNER)).usedBytes).toBe(5 * MB);
    });

    it("copies only the person's own results: another person's, a missing one and a file outside the Hub's own folders are not found", async () => {
      const theirs = await made(OTHER);
      await expect(
        storage.copyIntoContent(OWNER, theirs, 's'),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        storage.copyIntoContent(OWNER, `ai/image/${OWNER}/none.png`, 's'),
      ).rejects.toBeInstanceOf(NotFoundException);
      await prisma.storageObject.create({
        data: {
          wawuUserId: OWNER,
          key: `kyc/id-document/${OWNER}/x.png`,
          bytes: 10,
          contentType: 'image/png',
          folder: 'kyc/id-document',
          status: 'confirmed',
          confirmedAt: new Date(),
        },
      });
      await expect(
        storage.copyIntoContent(OWNER, `kyc/id-document/${OWNER}/x.png`, 's'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(copies).toHaveLength(0);
    });

    it('a bucket that refuses the copy leaves no reservation behind', async () => {
      const source = await made();
      objects.delete(source); // the bucket has lost the file
      await expect(
        storage.copyIntoContent(OWNER, source, 's'),
      ).rejects.toBeDefined();
      expect((await storage.usageFor(OWNER)).usedBytes).toBe(0);
      expect(
        await prisma.storageObject.count({
          where: { wawuUserId: OWNER, folder: 'content/full' },
        }),
      ).toBe(0);
    });
  });
});
