import { ConfigService } from '@nestjs/config';
import { PayloadTooLargeException } from '@nestjs/common';
import { StorageService, formatBytes } from '../storage.service';
import type { PrismaService } from '../../common/prisma/prisma.service';
import {
  FREE_STORAGE_BYTES,
  TICK_STORAGE_BYTES,
} from '../../common/creator-allowance';

/**
 * The per-account storage ceiling.
 *
 * Before this existed, `contentLength` was signed into the presigned PUT and
 * then discarded — which caps ONE file and caps a total of nothing. An account
 * could presign 2GB, then presign 2GB again, forever.
 *
 * These tests drive the real service against an in-memory row store, so they
 * assert the refusal and the arithmetic, not a mock's say-so.
 */
const GB = 1024 ** 3;

interface Row {
  id: string;
  wawuUserId: string;
  key: string;
  bytes: number;
  status: 'pending' | 'confirmed' | 'abandoned';
  createdAt: Date;
  /** Rows written by a test without one are creator content. */
  folder?: string;
}

/** The four stored tick columns on UserProfile (verification-state.ts). */
const TICKED = {
  creatorVerifiedAt: new Date('2026-01-01T00:00:00Z'),
  creatorVerifiedUntil: new Date('2099-01-01T00:00:00Z'),
  professionalVerifiedAt: null,
  professionalVerifiedUntil: null,
};
const UNTICKED = {
  creatorVerifiedAt: null,
  creatorVerifiedUntil: null,
  professionalVerifiedAt: null,
  professionalVerifiedUntil: null,
};

function buildService(
  opts: {
    creator?: boolean;
    rows?: Row[];
    tick?: boolean;
    slotsUsed?: number;
  } = {},
) {
  const rows: Row[] = opts.rows ?? [];
  const values: Record<string, string> = {
    STORAGE_ENDPOINT: 'https://example-bucket.t3.storageapi.dev',
    STORAGE_ACCESS_KEY_ID: 'tid_test',
    STORAGE_SECRET_ACCESS_KEY: 'secret_test',
    STORAGE_BUCKET: 'example-bucket',
    STORAGE_REGION: 'sjc',
  };
  const config = { get: (k: string) => values[k] } as unknown as ConfigService;

  const prisma = {
    storageObject: {
      aggregate: async ({
        where,
      }: {
        where: {
          wawuUserId: string;
          status: { in: string[] };
          folder: { in: string[] };
        };
      }) => ({
        _sum: {
          bytes: rows
            .filter(
              (r) =>
                r.wawuUserId === where.wawuUserId &&
                where.status.in.includes(r.status) &&
                where.folder.in.includes(r.folder ?? 'content/full'),
            )
            .reduce((n, r) => n + r.bytes, 0),
        },
      }),
      create: async ({
        data,
      }: {
        data: Omit<Row, 'id' | 'status' | 'createdAt'>;
      }) => {
        const row: Row = {
          ...data,
          id: `row-${rows.length}`,
          status: 'pending',
          createdAt: new Date(),
        };
        rows.push(row);
        return row;
      },
      // No stale rows in these cases; reconciliation has its own coverage.
      findMany: async () => [],
      update: async () => ({}),
    },
    creatorState: {
      // Read only by allowanceFor, for the upload count.
      findUnique: () =>
        Promise.resolve(
          opts.creator === false
            ? null
            : { wawuUserId: 'creator-1', slotsUsed: opts.slotsUsed ?? 0 },
        ),
    },
    userProfile: {
      // R-7: the storage allowance comes from the tick, not from whether a
      // CreatorState row exists.
      findUnique: () => Promise.resolve(opts.tick ? TICKED : UNTICKED),
    },
  } as unknown as PrismaService;

  return { service: new StorageService(config, prisma), rows };
}

const presign = (s: StorageService, bytes: number) =>
  s.presignUpload('creator-1', 'content/preview', 'image/jpeg', 'jpeg', bytes);

describe('storage quota', () => {
  it('gives an account with no creator state and no tick the free 1 GB', async () => {
    const { service } = buildService({ creator: false });
    const usage = await service.usageFor('creator-1');
    expect(usage.limitBytes).toBe(FREE_STORAGE_BYTES);
    expect(usage.limitBytes).toBe(1 * GB);
  });

  it('is 1 GB without a tick and 10 GB with one (R-7)', () => {
    // If either number changes, this fails before a creator hits the wall.
    expect(FREE_STORAGE_BYTES).toBe(1 * GB);
    expect(TICK_STORAGE_BYTES).toBe(10 * GB);
  });

  it('REFUSES an upload that would cross the ceiling', async () => {
    const { service } = buildService({
      rows: [
        {
          id: 'a',
          wawuUserId: 'creator-1',
          key: 'k',
          bytes: 1.9 * GB,
          status: 'confirmed',
          createdAt: new Date(),
        },
      ],
    });
    await expect(presign(service, 0.5 * GB)).rejects.toBeInstanceOf(
      PayloadTooLargeException,
    );
  });

  it('allows an upload that exactly fills the remaining space', async () => {
    const { service } = buildService({
      rows: [
        {
          id: 'a',
          wawuUserId: 'creator-1',
          key: 'k',
          bytes: 1 * GB - 1000,
          status: 'confirmed',
          createdAt: new Date(),
        },
      ],
    });
    await expect(presign(service, 1000)).resolves.toHaveProperty('uploadUrl');
  });

  it('counts a PENDING reservation, so quota cannot be spent twice before the first upload lands', async () => {
    // The exact hole a naive implementation leaves: the browser PUTs straight
    // to storage and never calls back, so if only confirmed rows counted, an
    // account could presign its whole allowance repeatedly in one second.
    const { service } = buildService();
    await presign(service, 0.6 * GB);
    await expect(presign(service, 0.5 * GB)).rejects.toBeInstanceOf(
      PayloadTooLargeException,
    );
  });

  it('does NOT count abandoned reservations against the account', async () => {
    const { service } = buildService({
      rows: [
        {
          id: 'a',
          wawuUserId: 'creator-1',
          key: 'k',
          bytes: 2 * GB,
          status: 'abandoned',
          createdAt: new Date(),
        },
      ],
    });
    await expect(presign(service, 1 * GB)).resolves.toHaveProperty('uploadUrl');
  });

  it('an account without a tick cannot store past 1 GB; one with a tick can, up to 10 GB', async () => {
    const rows = (): Row[] => [
      {
        id: 'a',
        wawuUserId: 'creator-1',
        key: 'k',
        bytes: 0.8 * GB,
        status: 'confirmed',
        createdAt: new Date(),
      },
    ];
    const free = buildService({ rows: rows() });
    await expect(presign(free.service, 0.5 * GB)).rejects.toBeInstanceOf(
      PayloadTooLargeException,
    );
    const ticked = buildService({ rows: rows(), tick: true });
    await expect(presign(ticked.service, 0.5 * GB)).resolves.toHaveProperty(
      'uploadUrl',
    );
    await expect(presign(ticked.service, 8.7 * GB)).resolves.toHaveProperty(
      'uploadUrl',
    );
    await expect(presign(ticked.service, 1 * GB)).rejects.toBeInstanceOf(
      PayloadTooLargeException,
    );
  });

  it('an account already above 1 GB keeps every file; only the new one is refused', async () => {
    // 2 GB was the free allowance before R-7. The rows stay as they are and
    // keep counting; nothing is marked abandoned or removed.
    const rows: Row[] = [
      {
        id: 'a',
        wawuUserId: 'creator-1',
        key: 'k',
        bytes: 1.5 * GB,
        status: 'confirmed',
        createdAt: new Date(),
      },
    ];
    const { service } = buildService({ rows });
    const refusal = await presign(service, 1000).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(PayloadTooLargeException);
    expect((refusal as PayloadTooLargeException).getResponse()).toEqual({
      message:
        'This file needs 1000 bytes, but only 0 bytes of your 1GB storage is free. A verification tick raises the limit to 10GB.',
      reason: {
        code: 'storage_limit_reached',
        neededBytes: 1000,
        usedBytes: 1.5 * GB,
        limitBytes: 1 * GB,
        tickHeld: false,
        storageBytesWithTick: 10 * GB,
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ bytes: 1.5 * GB, status: 'confirmed' });
    const usage = await service.usageFor('creator-1');
    expect(usage).toEqual({
      usedBytes: 1.5 * GB,
      limitBytes: 1 * GB,
      remainingBytes: 0,
    });
  });

  it('reports both allowances, used and allowed, for the screens that show them', async () => {
    const free = buildService({
      slotsUsed: 3,
      rows: [
        {
          id: 'a',
          wawuUserId: 'creator-1',
          key: 'k',
          bytes: 0.25 * GB,
          status: 'confirmed',
          createdAt: new Date(),
        },
      ],
    });
    await expect(free.service.allowanceFor('creator-1')).resolves.toEqual({
      tickHeld: false,
      uploads: { used: 3, allowed: 5, remaining: 2 },
      storage: {
        usedBytes: 0.25 * GB,
        limitBytes: 1 * GB,
        remainingBytes: 0.75 * GB,
      },
      free: { uploads: 5, storageBytes: 1 * GB },
      withTick: { uploads: 25, storageBytes: 10 * GB },
    });
    const ticked = buildService({ slotsUsed: 7, tick: true });
    await expect(
      ticked.service.allowanceFor('creator-1'),
    ).resolves.toMatchObject({
      tickHeld: true,
      uploads: { used: 7, allowed: 25, remaining: 18 },
      storage: { usedBytes: 0, limitBytes: 10 * GB, remainingBytes: 10 * GB },
    });
    const plain = buildService({ creator: false });
    await expect(
      plain.service.allowanceFor('creator-1'),
    ).resolves.toMatchObject({
      uploads: { used: 0, allowed: 5, remaining: 5 },
    });
  });

  it('tells an account with a tick to delete something, not to get a tick', async () => {
    const { service } = buildService({
      tick: true,
      rows: [
        {
          id: 'a',
          wawuUserId: 'creator-1',
          key: 'k',
          bytes: 9.9 * GB,
          status: 'confirmed',
          createdAt: new Date(),
        },
      ],
    });
    await expect(presign(service, 0.5 * GB)).rejects.toThrow(
      'This file needs 512MB, but only 102MB of your 10GB storage is free.',
    );
  });

  it('reports usage a person can act on', async () => {
    const { service } = buildService({
      rows: [
        {
          id: 'a',
          wawuUserId: 'creator-1',
          key: 'k',
          bytes: 0.5 * GB,
          status: 'confirmed',
          createdAt: new Date(),
        },
      ],
    });
    const usage = await service.usageFor('creator-1');
    // No `tier` on this shape any more: a field that always reported the same
    // word is a label pretending to be a distinction.
    expect(usage).toEqual({
      usedBytes: 0.5 * GB,
      limitBytes: 1 * GB,
      remainingBytes: 0.5 * GB,
    });
  });

  it('says how much room is left in words, not bytes', async () => {
    const { service } = buildService({
      rows: [
        {
          id: 'a',
          wawuUserId: 'creator-1',
          key: 'k',
          bytes: 0.9 * GB,
          status: 'confirmed',
          createdAt: new Date(),
        },
      ],
    });
    // Small remainders drop to MB rather than "0.1GB" — a person deciding
    // what to delete needs a number they can compare against a file.
    await expect(presign(service, 0.5 * GB)).rejects.toThrow(
      /needs 512MB, but only 102MB of your 1GB storage is free/,
    );
  });

  it('the 413 text never promises that deleting frees storage, and a ticked account is not told to get a tick', async () => {
    const free = buildService({
      rows: [
        {
          id: 'a',
          wawuUserId: 'creator-1',
          key: 'k',
          bytes: 1 * GB,
          status: 'confirmed',
          createdAt: new Date(),
        },
      ],
    });
    const ticked = buildService({
      tick: true,
      rows: [
        {
          id: 'a',
          wawuUserId: 'creator-1',
          key: 'k',
          bytes: 10 * GB,
          status: 'confirmed',
          createdAt: new Date(),
        },
      ],
    });
    const messages: string[] = [];
    for (const { service } of [free, ticked]) {
      const e = (await presign(service, 1000).catch(
        (x: unknown) => x,
      )) as PayloadTooLargeException;
      messages.push((e.getResponse() as { message: string }).message);
    }
    expect(messages[0]).toBe(
      'This file needs 1000 bytes, but only 0 bytes of your 1GB storage is free. A verification tick raises the limit to 10GB.',
    );
    expect(messages[1]).toBe(
      'This file needs 1000 bytes, but only 0 bytes of your 10GB storage is free.',
    );
    for (const m of messages) {
      expect(m).not.toMatch(/delete|remove/i);
      expect(m).not.toContain('\u2014');
    }
  });

  it.each([
    ['kyc/id-document', 'application/pdf', 'pdf'],
    ['avatars', 'image/jpeg', 'jpeg'],
    ['profile/cover', 'image/jpeg', 'jpeg'],
    ['legal/document', 'application/pdf', 'pdf'],
    ['service-application/document', 'application/pdf', 'pdf'],
    ['professional/document', 'application/pdf', 'pdf'],
    ['community/image', 'image/jpeg', 'jpeg'],
    ['community/message', 'image/jpeg', 'jpeg'],
    ['event/speaker', 'image/jpeg', 'jpeg'],
  ] as const)(
    'an account over its content storage can still upload to %s, and it does not count against content',
    async (folder, contentType, ext) => {
      for (const tick of [false, true]) {
        const { service } = buildService({
          tick,
          rows: [
            {
              id: 'a',
              wawuUserId: 'creator-1',
              key: 'k',
              bytes: (tick ? 10 : 1) * GB,
              status: 'confirmed',
              createdAt: new Date(),
            },
          ],
        });
        await expect(
          service.presignUpload('creator-1', folder, contentType, ext, 1000),
        ).resolves.toHaveProperty('uploadUrl');
        const usage = await service.usageFor('creator-1');
        expect(usage.usedBytes).toBe((tick ? 10 : 1) * GB);
        // New content is still refused for the same account.
        await expect(
          service.presignUpload(
            'creator-1',
            'content/full',
            'video/mp4',
            'mp4',
            1000,
          ),
        ).rejects.toBeInstanceOf(PayloadTooLargeException);
      }
    },
  );

  it('an exempt folder keeps its own type allowlist', async () => {
    const { service } = buildService();
    await expect(
      service.presignUpload('creator-1', 'avatars', 'video/mp4', 'mp4', 1000),
    ).rejects.toThrow(/not allowed in avatars/);
  });

  it('files in exempt folders do not count toward the content allowance', async () => {
    const { service } = buildService({
      rows: [
        {
          id: 'a',
          wawuUserId: 'creator-1',
          key: 'k',
          bytes: 0.9 * GB,
          status: 'confirmed',
          createdAt: new Date(),
          folder: 'kyc/id-document',
        },
      ],
    });
    await expect(
      service.presignUpload(
        'creator-1',
        'content/full',
        'video/mp4',
        'mp4',
        0.9 * GB,
      ),
    ).resolves.toHaveProperty('uploadUrl');
  });

  it('formats sizes the way a person reads them', () => {
    expect(formatBytes(2 * GB)).toBe('2GB');
    expect(formatBytes(1.5 * GB)).toBe('1.5GB');
    expect(formatBytes(400 * 1024 ** 2)).toBe('400MB');
    expect(formatBytes(12 * 1024)).toBe('12KB');
  });
});
