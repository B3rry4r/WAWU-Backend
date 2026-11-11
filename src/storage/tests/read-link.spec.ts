import {
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ConfigService } from '@nestjs/config';
import { StorageService } from '../storage.service';
import { serveAs } from '../dto/presign-upload.dto';
import { CoverLinkService } from '../cover-link';
import {
  LINK_MAX_SECONDS,
  LINK_WINDOW_SECONDS,
  shortestLife,
  windowStart,
} from '../read-link';
import { freshOwnImage } from '../own-image';
import type { PrismaService } from '../../common/prisma/prisma.service';
import {
  publishingOver,
  publishingTables,
} from '../../plans/tests/publishing-fakes';

function serviceWith(): StorageService {
  const values: Record<string, string> = {
    STORAGE_ENDPOINT: 'https://example-bucket.t3.storageapi.dev',
    STORAGE_ACCESS_KEY_ID: 'tid_test',
    STORAGE_SECRET_ACCESS_KEY: 'secret_test',
    STORAGE_BUCKET: 'example-bucket',
    STORAGE_REGION: 'sjc',
  };
  const config = { get: (k: string) => values[k] } as unknown as ConfigService;
  // An empty account on the default quota. These tests are about the SHAPE of
  // the signed URL, so the store only has to be big enough to say "yes".
  const prisma = {
    storageObject: {
      aggregate: () => Promise.resolve({ _sum: { bytes: 0 } }),
      create: () => Promise.resolve({}),
      findMany: () => Promise.resolve([]),
      update: () => Promise.resolve({}),
    },
    // The storage allowance and the publishing gate read the account's tier
    // and tick (R-7, TIER-02). `user-1` holds a running tier with room, so a
    // content file may be signed for it; the other accounts only sign
    // folders that are not products, which the gate never asks about.
    ...publishingTables(
      { tier: { endsInDays: 30, productsIncluded: 3 }, slotsUsed: 0 },
      'user-1',
    ),
  } as unknown as PrismaService;
  const { allowance, gate } = publishingOver(prisma);
  return new StorageService(config, prisma, allowance, gate);
}

const KEY = 'content/preview/user-1/cover.png';
const DAY = LINK_WINDOW_SECONDS * 1000;
// 2026-11-10 00:00:00 UTC, a window start.
const D0 = Date.UTC(2026, 10, 10);

/** Only the clock is faked, so signing (promises, timers) runs as usual. */
function at(ms: number) {
  jest.useFakeTimers({
    now: ms,
    doNotFake: [
      'nextTick',
      'setImmediate',
      'setTimeout',
      'setInterval',
      'clearTimeout',
      'clearInterval',
      'clearImmediate',
      'queueMicrotask',
      'performance',
      'hrtime',
    ],
  });
}
const q = (url: string) => new URL(url).searchParams;
const seconds = (url: string) => Number(q(url).get('X-Amz-Expires'));
const signedAt = (url: string) => {
  const d = q(url).get('X-Amz-Date') as string;
  return Date.UTC(
    +d.slice(0, 4),
    +d.slice(4, 6) - 1,
    +d.slice(6, 8),
    +d.slice(9, 11),
    +d.slice(11, 13),
    +d.slice(13, 15),
  );
};
/** Milliseconds a link stays valid for, measured from `now`. */
const lifeLeft = (url: string, now: number) =>
  signedAt(url) + seconds(url) * 1000 - now;

describe('HUB-IMG-LINKS read links', () => {
  const service = serviceWith();
  afterEach(() => jest.useRealTimers());

  it('gives the same link for the same key anywhere inside one window', async () => {
    at(D0 + 5_000);
    const first = await service.readUrlFor(KEY);
    at(D0 + 60_000);
    const aMinuteLater = await service.readUrlFor(KEY);
    at(D0 + DAY - 1_000);
    const lastSecond = await service.readUrlFor(KEY);
    expect(aMinuteLater).toBe(first);
    expect(lastSecond).toBe(first);
    expect(signedAt(first)).toBe(D0);
  });

  it('gives a new link in the next window, and another key another link', async () => {
    at(D0 + 5_000);
    const today = await service.readUrlFor(KEY);
    const other = await service.readUrlFor('content/preview/user-1/other.png');
    at(D0 + DAY + 5_000);
    const tomorrow = await service.readUrlFor(KEY);
    expect(tomorrow).not.toBe(today);
    expect(signedAt(tomorrow)).toBe(D0 + DAY);
    expect(other).not.toBe(today);
  });

  it('every link lives at least the stated shortest life: 6 days and 1 second for the default', async () => {
    expect(shortestLife()).toBe(LINK_MAX_SECONDS - LINK_WINDOW_SECONDS + 1);
    for (const offset of [0, 1_000, DAY / 2, DAY - 1_000]) {
      at(D0 + offset);
      const url = await service.readUrlFor(KEY);
      expect(seconds(url)).toBeLessThanOrEqual(LINK_MAX_SECONDS);
      expect(lifeLeft(url, D0 + offset)).toBeGreaterThanOrEqual(
        shortestLife() * 1000,
      );
    }
  });

  it('a link asked to live 3 days keeps its full 3 days at the end of a window', async () => {
    const ask = 3 * LINK_WINDOW_SECONDS;
    at(D0 + DAY - 1_000);
    const url = await service.readUrlFor(KEY, ask);
    expect(lifeLeft(url, D0 + DAY - 1_000)).toBeGreaterThanOrEqual(ask * 1000);
    expect(shortestLife(ask)).toBe(ask + 1);
  });

  it('a short-lived link (a chat attachment) is signed at the second, as before, ', async () => {
    at(D0 + 5_000);
    const url = await service.readUrlFor(KEY, 900);
    expect(signedAt(url)).toBe(D0 + 5_000);
    expect(seconds(url)).toBe(900);
    expect(q(url).get('response-cache-control')).toBeNull();
  });

  it('adds no cache parameter: the same parameter names as the unwindowed link', async () => {
    const url = await service.readUrlFor(KEY);
    expect(q(url).get('response-cache-control')).toBeNull();
    expect(q(url).get('response-content-disposition')).toBe('inline');
  });

  // The lead's proof: for every ask and every caller, the link has exactly the length and the parameter names of the
  // link signed the old way (current second, asked life); only X-Amz-Date, X-Amz-Expires (digit count) and
  // X-Amz-Signature values differ.
  it('is the same length, with the same parameter names, as the link signed at the current second, for every ask', async () => {
    const { client, bucket } = service as unknown as {
      client: S3Client;
      bucket: string;
    };
    const old = (key: string, ask: number) =>
      getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          ResponseContentType: serveAs(key).contentType,
          ResponseContentDisposition: serveAs(key).inline
            ? 'inline'
            : 'attachment',
        }),
        { expiresIn: ask },
      );
    const asks = [
      60, 900, 3600, 86_400, 86_401, 90_000, 99_999, 100_000, 259_200, 518_400,
      604_799, 604_800,
    ];
    const keys = [KEY, 'content/full/user-1/clip.mp4', 'kyc/user-1/id.pdf'];
    for (const key of keys) {
      for (const ask of asks) {
        at(D0 + 77_000);
        const now = await old(key, ask);
        const ours = await service.readUrlFor(key, ask);
        expect(ours.length).toBe(now.length);
        expect([...q(ours).keys()]).toEqual([...q(now).keys()]);
        expect(String(seconds(ours)).length).toBe(String(seconds(now)).length);
        const strip = (u: string) => {
          const p = q(u);
          for (const k of ['X-Amz-Date', 'X-Amz-Expires', 'X-Amz-Signature']) {
            p.set(k, 'x');
          }
          const c = p.get('X-Amz-Credential') as string;
          p.set('X-Amz-Credential', c.replace(/\/\d{8}\//, '/D/'));
          return p.toString();
        };
        expect(strip(ours)).toBe(strip(now));
        expect(new URL(ours).origin + new URL(ours).pathname).toBe(
          new URL(now).origin + new URL(now).pathname,
        );
      }
    }
  });

  it('atCurrentSecond signs at the second with the asked life, byte for byte as before the window', async () => {
    at(D0 + 123_000);
    const ours = await service.readUrlFor(KEY, undefined, {
      atCurrentSecond: true,
    });
    expect(signedAt(ours)).toBe(D0 + 123_000);
    expect(seconds(ours)).toBe(604_800);
    const fresh = await service.freshUrlFor(ours, { atCurrentSecond: true });
    expect(fresh).toBe(ours);
  });

  it('freshUrlFor and coverUrlFor give the same link inside a window', async () => {
    at(D0 + 1_000);
    const stored = await service.readUrlFor(KEY);
    at(D0 + 50_000);
    expect(await service.freshUrlFor(stored)).toBe(stored);
    expect(await service.coverUrlFor(KEY)).toBe(stored);
    at(D0 + DAY + 50_000);
    const next = (await service.coverUrlFor(KEY)) as string;
    expect(next).not.toBe(stored);
  });

  it('the cover link service (money rows) gives the very same link as the storage service', async () => {
    const values: Record<string, string> = {
      STORAGE_ENDPOINT: 'https://example-bucket.t3.storageapi.dev',
      STORAGE_ACCESS_KEY_ID: 'tid_test',
      STORAGE_SECRET_ACCESS_KEY: 'secret_test',
      STORAGE_BUCKET: 'example-bucket',
      STORAGE_REGION: 'sjc',
    };
    const covers = new CoverLinkService({
      get: (k: string) => values[k],
    } as unknown as ConfigService);
    at(D0 + 9_000);
    expect(await covers.linkFor(KEY)).toBe(await service.readUrlFor(KEY));
  });

  it('an avatar goes through the same signing: stable inside a window, signed again', async () => {
    const old = `https://example-bucket.t3.storageapi.dev/avatars/user-1/a.png?X-Amz-Expires=604800&X-Amz-Signature=dead`;
    at(D0 + 1_000);
    const a = await freshOwnImage(service, old, 'avatars', 'user-1');
    at(D0 + 61_000);
    const b = await freshOwnImage(service, old, 'avatars', 'user-1');
    expect(a).toBe(b);
    expect(a).not.toContain('Signature=dead');
    // someone else's picture is never signed
    expect(await freshOwnImage(service, old, 'avatars', 'user-2')).toBeNull();
  });

  it('windowStart rounds down to the start of the UTC day', () => {
    expect(windowStart(new Date(D0 + DAY - 1)).getTime()).toBe(D0);
    expect(windowStart(new Date(D0 + DAY)).getTime()).toBe(D0 + DAY);
  });
});

describe('HUB-IMG-LINKS the upload link is untouched', () => {
  const service = serviceWith();
  afterEach(() => jest.useRealTimers());

  it('carries no cache header, is signed at the second, lives 300 s and is exactly what a plain signature gives', async () => {
    at(D0 + 12_345);
    const { uploadUrl } = await service.presignUpload(
      'user-1',
      'avatars',
      'image/png',
      'png',
      4321,
    );
    const params = q(uploadUrl);
    expect(params.get('response-cache-control')).toBeNull();
    expect(params.get('X-Amz-Expires')).toBe('300');
    expect(signedAt(uploadUrl)).toBe(D0 + 12_000);
    expect(params.get('X-Amz-SignedHeaders')).toBe('content-length;host');
    // The same request signed by hand, with the options the SDK has always been given, byte for byte.
    const { client, bucket } = service as unknown as {
      client: S3Client;
      bucket: string;
    };
    const key = new URL(uploadUrl).pathname.replace(
      /^\/(example-bucket\/)?/,
      '',
    );
    const expected = await getSignedUrl(
      client,
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: 'image/png',
        ContentLength: 4321,
      }),
      { expiresIn: 300 },
    );
    expect(uploadUrl).toBe(expected);
  });
});
