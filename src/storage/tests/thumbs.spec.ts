// HUB-THUMBS: small copies of public pictures. Real pictures go through sharp; an in-memory bucket and an
// in-memory StorageObject table stand in for the store and the database.
/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-misused-promises -- in-memory stand-ins for the bucket and the table */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';
import sharp from 'sharp';
import { StorageService } from '../storage.service';
import type { PrismaService } from '../../common/prisma/prisma.service';
import { AppClientMiddleware } from '../../price-list/app-client';
import {
  decodedBytes,
  makeThumbs,
  MAX_THUMB_DECODE_BYTES,
  MAX_THUMB_SOURCE_PIXELS,
  UnreadablePicture,
} from '../thumbs/make-thumbs';
import * as makeMod from '../thumbs/make-thumbs';
import { ensureThumbsFor, forgetThumbs } from '../thumbs/ensure-thumbs';
import {
  THUMB_SOURCE_FAMILIES,
  thumbKey,
  thumbKeysOf,
  thumbOwnerOf,
  thumbSourceOk,
} from '../thumbs/thumb-keys';

const OWNER = 'user-1';
const AVATAR = `avatars/${OWNER}/a1.jpg`;

async function photo(
  w: number,
  h: number,
  extra?: (s: sharp.Sharp) => sharp.Sharp,
) {
  const base = sharp({
    create: {
      width: w,
      height: h,
      channels: 3,
      background: { r: 200, g: 90, b: 40 },
    },
  });
  return (extra ? extra(base) : base).jpeg().toBuffer();
}

type Row = {
  wawuUserId: string;
  key: string;
  status: string;
  folder: string;
  releasedAt: Date | null;
  removingAt: Date | null;
};

function world(
  objects: Record<string, Buffer> = {},
  rows: Row[] = [],
  declaredLength?: number,
) {
  const bucket = new Map<string, Buffer>(Object.entries(objects));
  const table = new Map<string, Row>(rows.map((r) => [r.key, r]));
  const puts: string[] = [];
  const sent: string[] = [];
  const client = {
    send: async (cmd: unknown) => {
      if (cmd instanceof PutObjectCommand) {
        puts.push(cmd.input.Key!);
        bucket.set(cmd.input.Key!, cmd.input.Body as Buffer);
        return {};
      }
      if (cmd instanceof DeleteObjectCommand) {
        bucket.delete(cmd.input.Key!);
        return {};
      }
      const key = (cmd as { input: { Key: string } }).input.Key;
      sent.push(key);
      const body = bucket.get(key);
      if (!body)
        throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
      if (cmd instanceof HeadObjectCommand)
        return { ContentLength: declaredLength ?? body.length };
      if (cmd instanceof GetObjectCommand)
        return {
          ContentLength: declaredLength ?? body.length,
          Body: Readable.from([body]),
        };
      return {};
    },
  };
  const prisma = {
    storageObject: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        table.get(where.key) ?? null,
      findMany: async ({ where }: { where: { key?: { in?: string[] } } }) =>
        (where.key?.in ?? [])
          .filter((k) => table.has(k))
          .map((k) => table.get(k)!),
      upsert: async ({
        where,
        create,
      }: {
        where: { key: string };
        create: Row;
      }) => {
        table.set(where.key, { ...create, releasedAt: null, removingAt: null });
        return {};
      },
      deleteMany: async ({ where }: { where: { key: string } }) => {
        table.delete(where.key);
        return { count: 1 };
      },
    },
  };
  const values: Record<string, string> = {
    STORAGE_ENDPOINT: 'https://example-bucket.t3.storageapi.dev',
    STORAGE_ACCESS_KEY_ID: 'tid_test',
    STORAGE_SECRET_ACCESS_KEY: 'secret_test',
    STORAGE_BUCKET: 'example-bucket',
    STORAGE_REGION: 'sjc',
  };
  const service = new StorageService(
    { get: (k: string) => values[k] } as unknown as ConfigService,
    prisma as unknown as PrismaService,
    {} as never,
    {} as never,
  );
  // The service's own S3 client (so links can be signed for real); only its network call is replaced.
  (service as unknown as { client: { send: unknown } }).client.send =
    client.send;
  return { service, bucket, table, puts, sent };
}

const own = (key: string): Row => ({
  wawuUserId: OWNER,
  key,
  status: 'confirmed',
  folder: key.split('/')[0],
  releasedAt: null,
  removingAt: null,
});

function asApp<T>(fn: () => Promise<T>, header = 'app'): Promise<T> {
  return new Promise((ok, no) =>
    new AppClientMiddleware().use(
      { headers: { 'x-wawu-client': header } } as never,
      {} as never,
      () => fn().then(ok, no),
    ),
  );
}

beforeEach(() => forgetThumbs());

describe('which pictures get copies (1: never a paid full file)', () => {
  it('copies exactly four public key families, and only pictures', () => {
    expect([...THUMB_SOURCE_FAMILIES]).toEqual([
      'avatars',
      'profile/cover',
      'content/cover',
      'content/preview',
    ]);
    for (const k of [
      'avatars/u/a.jpg',
      'profile/cover/u/a.png',
      'content/cover/u/a.webp',
      'content/preview/u/a.jpeg',
    ])
      expect(thumbSourceOk(k)).toBe(true);
  });

  it('never copies the paid full file or any other folder', () => {
    for (const k of [
      'content/full/u/a.jpg',
      'content/full/u/a.png',
      'kyc/id-document/u/a.jpg',
      'service-application/document/u/a.jpg',
      'professional/document/u/a.jpg',
      'legal/document/u/a.jpg',
      'community/message/u/a.jpg',
      'community/image/u/a.jpg',
      'event/banner/u/a.jpg',
      'profile/work/u/a.jpg',
      'ai/input-image/u/a.jpg',
      'ads/artwork/a.jpg',
      'chat/u/a.jpg',
      // not pictures
      'content/preview/u/a.pdf',
      'content/preview/u/a.mp4',
      'content/cover/u/a.gif',
      // a copy is not copied, and a key must be exactly family/owner/file
      'avatars/u/a.t96.webp',
      'avatars/u/x/a.jpg',
      'avatars/a.jpg',
      'avatars/u/../a.jpg',
    ])
      expect(thumbSourceOk(k)).toBe(false);
    expect(thumbKeysOf('content/full/u/a.jpg')).toEqual([]);
  });

  it('puts the copies beside the original under the same owner prefix', () => {
    expect(thumbKeysOf('content/cover/u9/abc.png')).toEqual([
      'content/cover/u9/abc.t96.webp',
      'content/cover/u9/abc.t640.webp',
    ]);
    expect(thumbOwnerOf('content/cover/u9/abc.png')).toBe('u9');
    expect(thumbKey('avatars/u/a.b.jpg', 96)).toBe('avatars/u/a.b.t96.webp');
  });

  it('makes no request at all for a paid full file', async () => {
    const key = `content/full/${OWNER}/p1.jpg`;
    const w = world({ [key]: await photo(900, 900) }, [own(key)]);
    await w.service.ensureThumbs(key, { background: true });
    await w.service.ensureThumbs(key, { background: true });
    expect(w.sent).toEqual([]);
    expect(w.puts).toEqual([]);
  });

  it('the sweep asks the database for the four public folders only', async () => {
    const seen: unknown[] = [];
    const w = world();
    (
      w.service as unknown as {
        prisma: { storageObject: { findMany: unknown } };
      }
    ).prisma.storageObject.findMany = async (a: unknown) => {
      seen.push(a);
      return [];
    };
    await w.service.sweepThumbs();
    expect(JSON.stringify(seen)).toContain(
      '"folder":{"in":["avatars","profile/cover","content/cover","content/preview"]}',
    );
    expect(JSON.stringify(seen)).not.toContain('content/full');
  });
});

describe('making the copies through StorageService (2)', () => {
  it('stores 96 px and 640 px WebP copies beside the original, never replacing it, with rows of the owner', async () => {
    const original = await photo(3000, 2000);
    const w = world({ [AVATAR]: original }, [own(AVATAR)]);
    await w.service.ensureThumbs(AVATAR, { background: true });
    expect(w.puts.sort()).toEqual([
      `avatars/${OWNER}/a1.t640.webp`,
      `avatars/${OWNER}/a1.t96.webp`,
    ]);
    expect(w.bucket.get(AVATAR)).toBe(original);
    const s96 = await sharp(
      w.bucket.get(`avatars/${OWNER}/a1.t96.webp`),
    ).metadata();
    const s640 = await sharp(
      w.bucket.get(`avatars/${OWNER}/a1.t640.webp`),
    ).metadata();
    expect(s96.format).toBe('webp');
    expect(Math.max(s96.width, s96.height)).toBe(96);
    expect(Math.max(s640.width, s640.height)).toBe(640);
    const row = w.table.get(`avatars/${OWNER}/a1.t96.webp`)!;
    expect(row).toMatchObject({
      wawuUserId: OWNER,
      status: 'confirmed',
      folder: 'thumbs',
    });
  });

  it('is idempotent: a second run reads and writes nothing', async () => {
    const w = world({ [AVATAR]: await photo(800, 800) }, [own(AVATAR)]);
    await w.service.ensureThumbs(AVATAR, { background: true });
    forgetThumbs();
    w.puts.length = 0;
    w.sent.length = 0;
    await w.service.ensureThumbs(AVATAR, { background: true });
    expect(w.puts).toEqual([]);
    expect(w.sent).toEqual([]);
  });

  it('skips an original that was released or has no row of its owner', async () => {
    const released = { ...own(AVATAR), releasedAt: new Date() };
    const a = world({ [AVATAR]: await photo(800, 800) }, [released]);
    await a.service.ensureThumbs(AVATAR, { background: true });
    expect(a.puts).toEqual([]);
    forgetThumbs();
    const b = world({ [AVATAR]: await photo(800, 800) }, []);
    await b.service.ensureThumbs(AVATAR, { background: true });
    expect(b.puts).toEqual([]);
  });

  it('removes the copies when the original goes (removeThumbsOf), objects and rows', async () => {
    const w = world({ [AVATAR]: await photo(800, 800) }, [own(AVATAR)]);
    await w.service.ensureThumbs(AVATAR, { background: true });
    expect(w.table.size).toBe(3);
    await w.service.removeThumbsOf(AVATAR);
    expect([...w.bucket.keys()]).toEqual([AVATAR]);
    expect([...w.table.keys()]).toEqual([AVATAR]);
  });

  it('no source file other than storage.service.ts writes to the bucket (thumbs included)', () => {
    const dir = join(__dirname, '..', 'thumbs');
    const found = spawnSync(
      'grep',
      [
        '-rlE',
        'PutObjectCommand|CreateMultipartUploadCommand|createPresignedPost|@aws-sdk/lib-storage',
        dir,
        '--include=*.ts',
      ],
      { encoding: 'utf8' },
    );
    expect(found.stdout.trim()).toBe('');
  });
});

describe('no EXIF, no location (3)', () => {
  it('drops GPS and every tag from both copies, and applies the orientation', async () => {
    const tagged = await photo(300, 100, (s) =>
      s.withExif({
        IFD0: { Make: 'Acme Phone' },
        IFD3: {
          GPSLatitudeRef: 'N',
          GPSLatitude: '51/1 30/1 0/1',
          GPSLongitudeRef: 'W',
          GPSLongitude: '0/1 7/1 0/1',
        },
      }),
    );
    // Camera orientation 6: the picture must be turned upright, then the tag is gone.
    const withGps = await sharp(tagged)
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const before = await sharp(withGps).metadata();
    expect(before.orientation).toBe(6);
    expect(before.exif).toBeDefined();
    expect(before.exif!.includes(Buffer.from('Acme Phone'))).toBe(true);
    expect(before.exif!.includes(Buffer.from('51/1'))).toBe(false); // GPS is stored as rationals, not text
    // The GPS IFD is really there in the input: its pointer tag (0x8825) is in the Exif block.
    expect(
      before.exif!.includes(Buffer.from([0x25, 0x88])) ||
        before.exif!.includes(Buffer.from([0x88, 0x25])),
    ).toBe(true);

    const copies = await makeThumbs(withGps);
    for (const buf of Object.values(copies)) {
      const m = await sharp(buf).metadata();
      expect(m.exif).toBeUndefined();
      expect(m.icc).toBeUndefined();
      expect(m.xmp).toBeUndefined();
      expect(buf.includes(Buffer.from('Acme Phone'))).toBe(false);
      expect(buf.includes(Buffer.from('EXIF'))).toBe(false);
      expect(buf.includes(Buffer.from('GPS'))).toBe(false);
      expect(m.orientation).toBeUndefined();
    }
    const m640 = await sharp(copies[640]).metadata();
    expect([m640.width, m640.height]).toEqual([100, 300]);
  });
});

describe('a bad picture never fails or slows the path (4)', () => {
  it('a broken file is left, logged, and the call returns', async () => {
    const key = AVATAR;
    const w = world({ [key]: Buffer.from('this is not a picture at all') }, [
      own(key),
    ]);
    await expect(
      w.service.ensureThumbs(key, { background: true }),
    ).resolves.toBeUndefined();
    expect(w.puts).toEqual([]);
  });

  it('a truncated picture is refused by the library, not stored half done', async () => {
    const good = await photo(2000, 2000, (s) => s.blur(0.3));
    const w = world(
      { [AVATAR]: good.subarray(0, Math.floor(good.length / 3)) },
      [own(AVATAR)],
    );
    await w.service.ensureThumbs(AVATAR, { background: true });
    expect(w.puts).toEqual([]);
  });

  it('a 40 MB file is not read (the declared length is over the cap) and no copy is made', async () => {
    const w = world(
      { [AVATAR]: await photo(100, 100) },
      [own(AVATAR)],
      40 * 1024 * 1024,
    );
    await w.service.ensureThumbs(AVATAR, { background: true });
    expect(w.puts).toEqual([]);
  });

  it('a 20000 x 20000 picture (a few hundred bytes) is refused from its header', async () => {
    const chunk = (type: string, data: Buffer) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length);
      const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(body) >>> 0);
      return Buffer.concat([len, body, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(20000, 0);
    ihdr.writeUInt32BE(20000, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 0; // grey
    const bomb = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk(
        'IDAT',
        Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01]),
      ),
      chunk('IEND', Buffer.alloc(0)),
    ]);
    expect(bomb.length).toBeLessThan(200);
    expect(20000 * 20000).toBeGreaterThan(MAX_THUMB_SOURCE_PIXELS);
    const started = Date.now();
    await expect(makeThumbs(bomb)).rejects.toBeInstanceOf(UnreadablePicture);
    expect(Date.now() - started).toBeLessThan(2000);
    const w = world({ [AVATAR]: bomb }, [own(AVATAR)]);
    await w.service.ensureThumbs(AVATAR, { background: true });
    expect(w.puts).toEqual([]);
  });

  it('an animated picture gets still copies of its first frame', async () => {
    const frame = Buffer.alloc(60 * 60 * 3, 120);
    const animated = await sharp(
      Buffer.concat([frame, Buffer.alloc(frame.length, 30)]),
      {
        raw: { width: 60, height: 120, channels: 3, pageHeight: 60 },
      },
    )
      .webp({ loop: 0, delay: [100, 100] })
      .toBuffer();
    expect((await sharp(animated, { animated: true }).metadata()).pages).toBe(
      2,
    );
    const copies = await makeThumbs(animated);
    const m = await sharp(copies[96], { animated: true }).metadata();
    expect(m.pages ?? 1).toBe(1);
    expect(m.height).toBe(60);
  });

  it('work that runs past its time limit is given up on, logged, and does not throw', async () => {
    const logs: string[] = [];
    const big = await sharp(randomBytes(3000 * 3000 * 3), {
      raw: { width: 3000, height: 3000, channels: 3 },
    })
      .png()
      .toBuffer();
    const outcome = await ensureThumbsFor(
      {
        logger: {
          log: () => undefined,
          warn: (m: string) => void logs.push(m),
        },
        enabled: true,
        rowOf: async () => own(AVATAR),
        haveRows: async () => new Set(),
        read: async () => big,
        put: async () => {
          throw new Error('must not be reached');
        },
        discard: async () => undefined,
        workMs: 1,
      },
      AVATAR,
    );
    expect(outcome).toBe('left');
    expect(logs.join(' ')).toContain('took too long');
  });
  it('a confirm never waits for copies: it returns at once while slow work carries on in the background', async () => {
    const SLOW = `avatars/${OWNER}/slow.jpg`;
    const w = world({ [SLOW]: await photo(500, 500) }, [own(SLOW)]);
    const real = w.service['client'] as unknown as {
      send: (c: unknown) => Promise<unknown>;
    };
    const fast = real.send.bind(real);
    real.send = async (c: unknown) => {
      if (c instanceof GetObjectCommand)
        await new Promise((r) => setTimeout(r, 1500));
      return fast(c);
    };
    const started = Date.now();
    await w.service.ensureThumbs(SLOW);
    expect(Date.now() - started).toBeLessThan(300);
    expect(w.puts).toEqual([]);
    await new Promise((r) => setTimeout(r, 2500));
    expect(w.puts.length).toBe(2);
  });
});

describe('serving the copies (5)', () => {
  it('signs both links through read-link.ts: the same links all day, only on the app', async () => {
    const w = world({ [AVATAR]: await photo(800, 800) }, [own(AVATAR)]);
    await w.service.ensureThumbs(AVATAR, { background: true });
    const a = await asApp(() =>
      w.service.thumbsFor([AVATAR, null, 'content/full/u/x.jpg']),
    );
    const b = await asApp(() => w.service.thumbsFor([AVATAR]));
    expect(a[0]).toEqual(b[0]);
    expect(a[1]).toBeNull();
    expect(a[2]).toBeNull();
    const direct = await w.service.readUrlFor(`avatars/${OWNER}/a1.t96.webp`);
    expect(a[0]!.w96).toBe(direct);
    expect(a[0]!.w96).toContain('X-Amz-Signature=');
    expect(a[0]!.w640).toContain('a1.t640.webp');
    // the website, the dashboard, a missing header and the site flow get nothing
    expect(await w.service.thumbsFor([AVATAR])).toEqual([null]);
    expect(await asApp(() => w.service.thumbsFor([AVATAR]), 'site')).toEqual([
      null,
    ]);
    expect(await w.service.pieceThumbs(AVATAR, null)).toEqual({});
  });

  it('serves nothing for a picture with only one of its two copies', async () => {
    const w = world({}, [own(AVATAR), own(`avatars/${OWNER}/a1.t96.webp`)]);
    expect(await asApp(() => w.service.thumbsFor([AVATAR]))).toEqual([null]);
  });
});

describe('memory (round 1): the worst picture accepted stays small', () => {
  it('counts what a picture takes once decoded, doubled for an interlaced PNG', () => {
    const png16il = {
      width: 7000,
      height: 7000,
      channels: 4,
      depth: 'ushort',
      format: 'png',
      isProgressive: true,
    } as sharp.Metadata;
    expect(decodedBytes(png16il)).toBe(7000 * 7000 * 4 * 2 * 2);
    expect(decodedBytes(png16il)).toBeGreaterThan(MAX_THUMB_DECODE_BYTES);
    const photo = {
      width: 5000,
      height: 5000,
      channels: 3,
      depth: 'uchar',
      format: 'jpeg',
    } as sharp.Metadata;
    expect(decodedBytes(photo)).toBeLessThanOrEqual(MAX_THUMB_DECODE_BYTES);
  });

  it('refuses a 16-bit interlaced RGBA PNG whose decode would take over the budget, before decoding it', async () => {
    const png = await sharp(Buffer.alloc(3000 * 3000 * 4 * 2, 0x40), {
      raw: { width: 3000, height: 3000, channels: 4, depth: 'ushort' },
    } as unknown as sharp.SharpOptions)
      .toColourspace('rgb16')
      .png({ bitdepth: 16, progressive: true } as sharp.PngOptions)
      .toBuffer();
    const started = Date.now();
    await expect(makeThumbs(png)).rejects.toThrow('too much memory');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('makes one picture at a time in the whole process, however many confirms arrive', async () => {
    let now = 0;
    let most = 0;
    const photoBuf = await photo(800, 600);
    const mk = (k: string) =>
      ensureThumbsFor(
        {
          logger: { log: () => undefined, warn: () => undefined },
          enabled: true,
          rowOf: async () => own(k),
          haveRows: async () => new Set(),
          read: async () => {
            now += 1;
            most = Math.max(most, now);
            await new Promise((r) => setTimeout(r, 30));
            return photoBuf;
          },
          put: async (p: { key: string }) => {
            if (p.key.endsWith('.t640.webp')) now -= 1;
          },
          discard: async () => undefined,
        },
        k,
      );
    const keys = [1, 2, 3, 4, 5].map((n) => `avatars/${OWNER}/q${n}.jpg`);
    const out = await Promise.all(keys.map(mk));
    expect(out.every((o) => o === 'made')).toBe(true);
    expect(most).toBe(1);
  });
});

describe('round 2: the sweep and the queue slot', () => {
  it('a sweep spends its 20 looks only on pictures that still need copies', async () => {
    const good = Array.from(
      { length: 50 },
      (_, n) => `avatars/${OWNER}/g${n}.jpg`,
    );
    const needy = Array.from(
      { length: 5 },
      (_, n) => `avatars/${OWNER}/n${n}.jpg`,
    );
    const objects: Record<string, Buffer> = {};
    const rows: Row[] = [];
    const img = await photo(200, 200);
    for (const k of [...good, ...needy]) {
      objects[k] = img;
      rows.push(own(k));
    }
    for (const k of good) for (const t of thumbKeysOf(k)) rows.push(own(t));
    const w = world(objects, rows);
    const prisma = (
      w.service as unknown as {
        prisma: {
          storageObject: {
            findMany: (a: {
              where: { key?: { in?: string[] } };
            }) => Promise<Row[]>;
          };
        };
      }
    ).prisma;
    const keyed = prisma.storageObject.findMany;
    // newest first: the 50 pictures that have their copies, then the 5 that do not
    const order = [...good, ...needy].map((k) => ({ key: k }));
    prisma.storageObject.findMany = async (a) =>
      a.where.key?.in ? keyed(a) : (order as unknown as Row[]);
    const looked = await w.service.sweepThumbs(20);
    expect(looked).toBe(5);
    expect(w.puts.length).toBe(10);
  });

  it('keeps the queue slot until the decode truly ends, so two decodes never overlap', async () => {
    const real = makeMod.makeThumbs;
    let active = 0;
    let most = 0;
    const spy = jest
      .spyOn(makeMod, 'makeThumbs')
      .mockImplementation(async (b) => {
        active += 1;
        most = Math.max(most, active);
        await new Promise((r) => setTimeout(r, 200));
        active -= 1;
        return real(b);
      });
    const img = await photo(200, 200);
    const mk = (k: string) =>
      ensureThumbsFor(
        {
          logger: { log: () => undefined, warn: () => undefined },
          enabled: true,
          rowOf: async () => own(k),
          haveRows: async () => new Set(),
          read: async () => img,
          put: async () => undefined,
          discard: async () => undefined,
          workMs: 20,
        },
        k,
      );
    const out = await Promise.all(
      [`avatars/${OWNER}/t1.jpg`, `avatars/${OWNER}/t2.jpg`].map(mk),
    );
    await new Promise((r) => setTimeout(r, 600));
    spy.mockRestore();
    expect(out).toEqual(['left', 'left']);
    expect(most).toBe(1);
  });
});
