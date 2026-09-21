import { ConfigService } from '@nestjs/config';
import { PayloadTooLargeException } from '@nestjs/common';
import { StorageService, formatBytes } from '../storage.service';
import type { PrismaService } from '../../common/prisma/prisma.service';
import {
  STORAGE_BYTES_PER_ACCOUNT,
  DEFAULT_STORAGE_BYTES,
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
}

function buildService(opts: { creator?: boolean; rows?: Row[] } = {}) {
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
      aggregate: async ({ where }: { where: { wawuUserId: string; status: { in: string[] } } }) => ({
        _sum: {
          bytes: rows
            .filter((r) => r.wawuUserId === where.wawuUserId && where.status.in.includes(r.status))
            .reduce((n, r) => n + r.bytes, 0),
        },
      }),
      create: async ({ data }: { data: Omit<Row, 'id' | 'status' | 'createdAt'> }) => {
        const row: Row = { ...data, id: `row-${rows.length}`, status: 'pending', createdAt: new Date() };
        rows.push(row);
        return row;
      },
      // No stale rows in these cases; reconciliation has its own coverage.
      findMany: async () => [],
      update: async () => ({}),
    },
    creatorState: {
      // Flat allowance now: the only thing asked of this row is whether it
      // exists, which separates a creator's quota from the one a plain
      // account gets for an avatar or a KYC document.
      findUnique: async () =>
        opts.creator === false ? null : { wawuUserId: 'creator-1' },
    },
  } as unknown as PrismaService;

  return { service: new StorageService(config, prisma), rows };
}

const presign = (s: StorageService, bytes: number) =>
  s.presignUpload('creator-1', 'content/preview', 'image/jpeg', 'jpeg', bytes);

describe('storage quota', () => {
  it('gives an account with no creator state the 2GB floor', async () => {
    const { service } = buildService({ creator: false });
    const usage = await service.usageFor('creator-1');
    expect(usage.limitBytes).toBe(DEFAULT_STORAGE_BYTES);
    expect(usage.limitBytes).toBe(2 * GB);
  });

  it('is the same 2GB for every creator account', () => {
    // One ceiling, no ladder: the tiers that sold a larger one are gone. If
    // this number changes, this fails before a creator hits the wall.
    expect(STORAGE_BYTES_PER_ACCOUNT).toBe(2 * GB);
    expect(STORAGE_BYTES_PER_ACCOUNT).toBe(DEFAULT_STORAGE_BYTES);
  });

  it('REFUSES an upload that would cross the ceiling', async () => {
    const { service } = buildService({
      rows: [{ id: 'a', wawuUserId: 'creator-1', key: 'k', bytes: 1.9 * GB, status: 'confirmed', createdAt: new Date() }],
    });
    await expect(presign(service, 0.5 * GB)).rejects.toBeInstanceOf(PayloadTooLargeException);
  });

  it('allows an upload that exactly fills the remaining space', async () => {
    const { service } = buildService({
      rows: [{ id: 'a', wawuUserId: 'creator-1', key: 'k', bytes: 2 * GB - 1000, status: 'confirmed', createdAt: new Date() }],
    });
    await expect(presign(service, 1000)).resolves.toHaveProperty('uploadUrl');
  });

  it('counts a PENDING reservation, so quota cannot be spent twice before the first upload lands', async () => {
    // The exact hole a naive implementation leaves: the browser PUTs straight
    // to storage and never calls back, so if only confirmed rows counted, an
    // account could presign its whole allowance repeatedly in one second.
    const { service } = buildService();
    await presign(service, 1.5 * GB);
    await expect(presign(service, 1 * GB)).rejects.toBeInstanceOf(PayloadTooLargeException);
  });

  it('does NOT count abandoned reservations against the account', async () => {
    const { service } = buildService({
      rows: [{ id: 'a', wawuUserId: 'creator-1', key: 'k', bytes: 2 * GB, status: 'abandoned', createdAt: new Date() }],
    });
    await expect(presign(service, 1 * GB)).resolves.toHaveProperty('uploadUrl');
  });

  it('refuses the same file for every creator, with no tier that buys past it', async () => {
    const rows = (): Row[] => [
      { id: 'a', wawuUserId: 'creator-1', key: 'k', bytes: 1.8 * GB, status: 'confirmed', createdAt: new Date() },
    ];
    // This file used to fit on Pro Max and not on Basic. There is one ceiling
    // now, so it is refused whoever asks.
    for (const rowset of [rows(), rows()]) {
      const { service } = buildService({ rows: rowset });
      await expect(presign(service, 1 * GB)).rejects.toBeInstanceOf(PayloadTooLargeException);
    }
  });

  it('reports usage a person can act on', async () => {
    const { service } = buildService({
      rows: [{ id: 'a', wawuUserId: 'creator-1', key: 'k', bytes: 1 * GB, status: 'confirmed', createdAt: new Date() }],
    });
    const usage = await service.usageFor('creator-1');
    // No `tier` on this shape any more: a field that always reported the same
    // word is a label pretending to be a distinction.
    expect(usage).toEqual({ usedBytes: 1 * GB, limitBytes: 2 * GB, remainingBytes: 1 * GB });
  });

  it('says how much room is left in words, not bytes', async () => {
    const { service } = buildService({
      rows: [{ id: 'a', wawuUserId: 'creator-1', key: 'k', bytes: 1.9 * GB, status: 'confirmed', createdAt: new Date() }],
    });
    // Small remainders drop to MB rather than "0.1GB" — a person deciding
    // what to delete needs a number they can compare against a file.
    await expect(presign(service, 0.5 * GB)).rejects.toThrow(
      /needs 512MB, but only 102MB of your 2GB storage is free/,
    );
  });

  it('formats sizes the way a person reads them', () => {
    expect(formatBytes(2 * GB)).toBe('2GB');
    expect(formatBytes(1.5 * GB)).toBe('1.5GB');
    expect(formatBytes(400 * 1024 ** 2)).toBe('400MB');
    expect(formatBytes(12 * 1024)).toBe('12KB');
  });
});
