import { ConfigService } from '@nestjs/config';
import { PayloadTooLargeException } from '@nestjs/common';
import { StorageService, formatBytes } from '../storage.service';
import type { PrismaService } from '../../common/prisma/prisma.service';
import {
  STORAGE_ALLOWANCE_BY_TIER,
  DEFAULT_STORAGE_BYTES,
} from '../../common/creator-tier-allowance';

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

function buildService(opts: { tier?: 'basic' | 'pro' | 'pro_max' | null; rows?: Row[] } = {}) {
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
      findUnique: async () => (opts.tier ? { tier: opts.tier } : null),
    },
  } as unknown as PrismaService;

  return { service: new StorageService(config, prisma), rows };
}

const presign = (s: StorageService, bytes: number) =>
  s.presignUpload('creator-1', 'content/preview', 'image/jpeg', 'jpeg', bytes);

describe('storage quota', () => {
  it('gives an account with no creator state the 2GB floor', async () => {
    const { service } = buildService({ tier: null });
    const usage = await service.usageFor('creator-1');
    expect(usage.limitBytes).toBe(DEFAULT_STORAGE_BYTES);
    expect(usage.limitBytes).toBe(2 * GB);
  });

  it('matches the storage each plan is sold with', () => {
    // 2GB for everyone, 5GB on Pro Max (product owner, 31 Aug 2026). If the
    // pricing copy changes, this fails before a creator hits the wall.
    expect(STORAGE_ALLOWANCE_BY_TIER.basic).toBe(2 * GB);
    expect(STORAGE_ALLOWANCE_BY_TIER.pro).toBe(2 * GB);
    expect(STORAGE_ALLOWANCE_BY_TIER.pro_max).toBe(5 * GB);
  });

  it('REFUSES an upload that would cross the ceiling', async () => {
    const { service } = buildService({
      tier: 'basic',
      rows: [{ id: 'a', wawuUserId: 'creator-1', key: 'k', bytes: 1.9 * GB, status: 'confirmed', createdAt: new Date() }],
    });
    await expect(presign(service, 0.5 * GB)).rejects.toBeInstanceOf(PayloadTooLargeException);
  });

  it('allows an upload that exactly fills the remaining space', async () => {
    const { service } = buildService({
      tier: 'basic',
      rows: [{ id: 'a', wawuUserId: 'creator-1', key: 'k', bytes: 2 * GB - 1000, status: 'confirmed', createdAt: new Date() }],
    });
    await expect(presign(service, 1000)).resolves.toHaveProperty('uploadUrl');
  });

  it('counts a PENDING reservation, so quota cannot be spent twice before the first upload lands', async () => {
    // The exact hole a naive implementation leaves: the browser PUTs straight
    // to storage and never calls back, so if only confirmed rows counted, an
    // account could presign its whole allowance repeatedly in one second.
    const { service } = buildService({ tier: 'basic' });
    await presign(service, 1.5 * GB);
    await expect(presign(service, 1 * GB)).rejects.toBeInstanceOf(PayloadTooLargeException);
  });

  it('does NOT count abandoned reservations against the account', async () => {
    const { service } = buildService({
      tier: 'basic',
      rows: [{ id: 'a', wawuUserId: 'creator-1', key: 'k', bytes: 2 * GB, status: 'abandoned', createdAt: new Date() }],
    });
    await expect(presign(service, 1 * GB)).resolves.toHaveProperty('uploadUrl');
  });

  it('gives Pro Max the larger ceiling, so the same file is refused on Basic and allowed on Pro Max', async () => {
    const rows = (): Row[] => [
      { id: 'a', wawuUserId: 'creator-1', key: 'k', bytes: 1.8 * GB, status: 'confirmed', createdAt: new Date() },
    ];
    const basic = buildService({ tier: 'basic', rows: rows() });
    const proMax = buildService({ tier: 'pro_max', rows: rows() });
    await expect(presign(basic.service, 1 * GB)).rejects.toBeInstanceOf(PayloadTooLargeException);
    await expect(presign(proMax.service, 1 * GB)).resolves.toHaveProperty('uploadUrl');
  });

  it('reports usage a person can act on', async () => {
    const { service } = buildService({
      tier: 'pro_max',
      rows: [{ id: 'a', wawuUserId: 'creator-1', key: 'k', bytes: 1 * GB, status: 'confirmed', createdAt: new Date() }],
    });
    const usage = await service.usageFor('creator-1');
    expect(usage).toEqual({ usedBytes: 1 * GB, limitBytes: 5 * GB, remainingBytes: 4 * GB, tier: 'pro_max' });
  });

  it('says how much room is left in words, not bytes', async () => {
    const { service } = buildService({
      tier: 'basic',
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
    expect(formatBytes(5 * GB)).toBe('5GB');
    expect(formatBytes(1.5 * GB)).toBe('1.5GB');
    expect(formatBytes(400 * 1024 ** 2)).toBe('400MB');
    expect(formatBytes(12 * 1024)).toBe('12KB');
  });
});
