import {
  DeleteObjectCommand,
  HeadObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import type { Logger } from '@nestjs/common';
import type { PrismaService } from '../common/prisma/prisma.service';
import { LOCKED_TX, lockStorageQuota } from './storage-lock';
import { isClaimed } from './upload-release';

/**
 * ME-04 rounds 3 and 4: a file that lands after its upload was given up.
 *
 * The PUT link a presign hands out stays valid for its whole life (300 s) no
 * matter what the Hub has since done with the row. So a person can presign
 * (counted), send the file, release it (uncounted, object deleted) and send
 * the same file again with the same link: the object is back in the bucket,
 * its row is `abandoned`, and nothing counts it. Repeated, that stores without
 * a ceiling. A slow honest upload can land late the same way.
 *
 * This is the Hub's own sweep for that. It looks at every `abandoned` row in a
 * content folder whose link has expired, with a margin on top for a slow upload
 * that began just before it did, and asks the bucket whether the file is there.
 * What it does with a file it finds depends on the row:
 *
 * - The person RELEASED it and no listing uses it: the file is deleted, and the
 *   row records that (`sweptRemovedAt`).
 * - The person never released it (an upload that took longer than the give-up
 *   time, or one that was never confirmed): the file is COUNTED, the row
 *   becomes `confirmed`, as a confirm would have made it. It is never deleted.
 * - A listing uses it: it is counted too, released or not. A listing can only
 *   name a file that is not given up, so a released file that a listing uses
 *   should not exist; if one does it is counted and logged, never deleted.
 *
 * A row whose file has not arrived is looked at again an hour and a day after
 * the first look (`sweptHourAt`, `sweptDayAt`), then never: a PUT that is still
 * running when the first look happens lands afterwards.
 *
 * Rules it keeps:
 * - Only a definite answer settles a row. A bucket that cannot be asked, or a
 *   delete it refuses, leaves the row for the next pass.
 * - Everything that changes a row, and the delete itself, happens under the
 *   person's storage lock (storage-lock.ts), the one a release, a confirm and a
 *   create take, and the row is read again inside it. So a listing that names
 *   the key a moment earlier is seen and the file kept, a confirm that counted
 *   the file is seen, and two sweeps at once settle a row once (the second
 *   finds it done and counts nothing).
 */
export interface LateSweepDeps {
  client: S3Client | null;
  bucket: string;
  /** The folders whose files count against the allowance (the only ones swept). */
  folders: readonly string[];
  prisma: PrismaService;
  logger: Logger;
}

export interface LateSweepOptions {
  /** How long an upload link lives, in seconds. */
  linkSeconds: number;
  /** Extra time after the link has expired before a row is looked at, in seconds. */
  marginSeconds: number;
  /** Sweep only this person's rows (a spec, or a future per-person trigger). */
  wawuId?: string;
  /** The clock; a spec passes its own. */
  now?: Date;
  /** Rows asked of the bucket together. */
  batch?: number;
  /** Passes one sweep makes at most, so a run never goes on without end. */
  maxBatches?: number;
}

export interface LateSweepResult {
  /** Rows the sweep settled: removed a file, counted one, or found none and recorded the look. */
  settled: number;
  /** Files it deleted (released by the person, used by no listing). */
  removed: number;
  /** Files it found and counted (never released, or used by a listing). */
  counted: number;
  /** Rows it could not settle (bucket down, delete refused): they stay for the next pass. */
  left: number;
}

type Verdict = 'removed' | 'counted' | 'looked' | 'left' | 'skipped';

/** Which look a row is due: the first, an hour after it, or a day after it. */
type Look = 'first' | 'hour' | 'day';

interface SweepRow {
  id: string;
  key: string;
  wawuUserId: string;
  sweptAt: Date | null;
  sweptHourAt: Date | null;
  sweptDayAt: Date | null;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_BATCH = 50;
const DEFAULT_MAX_BATCHES = 10;
/** Rows settled together: each holds one database connection while it waits for its person's lock. */
const SETTLE_CONCURRENCY = 4;

function statusOf(err: unknown): number | undefined {
  return (err as { $metadata?: { httpStatusCode?: number } }).$metadata
    ?.httpStatusCode;
}

/** The look a row is due now, or null when it is not due one. */
function lookDue(row: SweepRow, now: Date): Look | null {
  if (!row.sweptAt) return 'first';
  const since = now.getTime() - row.sweptAt.getTime();
  if (!row.sweptDayAt && since >= DAY_MS) return 'day';
  if (!row.sweptHourAt && since >= HOUR_MS) return 'hour';
  return null;
}

/** What a look writes on the row. A day look also covers the hour look it replaces. */
function lookData(look: Look, row: SweepRow, now: Date) {
  if (look === 'first') return { sweptAt: now };
  if (look === 'hour') return { sweptHourAt: now };
  return row.sweptHourAt
    ? { sweptDayAt: now }
    : { sweptDayAt: now, sweptHourAt: now };
}

/** The column that must still be empty for this look to be written. */
const LOOK_GUARD: Record<Look, 'sweptAt' | 'sweptHourAt' | 'sweptDayAt'> = {
  first: 'sweptAt',
  hour: 'sweptHourAt',
  day: 'sweptDayAt',
};

export async function sweepLateFiles(
  deps: LateSweepDeps,
  opts: LateSweepOptions,
): Promise<LateSweepResult> {
  const { client, folders, prisma, logger } = deps;
  const result: LateSweepResult = {
    settled: 0,
    removed: 0,
    counted: 0,
    left: 0,
  };
  if (!client) return result;

  const now = opts.now ?? new Date();
  const cutoff = new Date(
    now.getTime() - (opts.linkSeconds + opts.marginSeconds) * 1000,
  );
  const hourAgo = new Date(now.getTime() - HOUR_MS);
  const dayAgo = new Date(now.getTime() - DAY_MS);
  const batch = opts.batch ?? DEFAULT_BATCH;
  const maxBatches = opts.maxBatches ?? DEFAULT_MAX_BATCHES;
  // Rows left for the next pass are not asked again in this one, so the loop
  // ends even during an outage.
  const asked: string[] = [];

  for (let pass = 0; pass < maxBatches; pass++) {
    const rows = await prisma.storageObject.findMany({
      where: {
        status: 'abandoned',
        // A row whose file was removed is done for good.
        sweptRemovedAt: null,
        folder: { in: [...folders] },
        OR: [
          { sweptAt: null, createdAt: { lt: cutoff } },
          { sweptAt: { lte: hourAgo }, sweptHourAt: null },
          { sweptAt: { lte: dayAgo }, sweptDayAt: null },
        ],
        ...(opts.wawuId ? { wawuUserId: opts.wawuId } : {}),
        ...(asked.length > 0 ? { id: { notIn: asked } } : {}),
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        key: true,
        wawuUserId: true,
        sweptAt: true,
        sweptHourAt: true,
        sweptDayAt: true,
      },
      take: batch,
    });
    if (rows.length === 0) break;
    asked.push(...rows.map((row) => row.id));

    // Every row is asked of the bucket together; the ones with a file then
    // settle a few at a time, each under its person's lock.
    const asks = await Promise.all(
      rows.map(async (row) => ({ row, held: await bucketHolds(deps, row) })),
    );
    const verdicts = await mapLimit(
      asks,
      SETTLE_CONCURRENCY,
      async (ask): Promise<Verdict> => {
        const look = lookDue(ask.row, now);
        if (!look || ask.held === 'unknown') return 'left';
        try {
          return ask.held === 'absent'
            ? await recordLook(deps, ask.row, look, now)
            : await settleFile(deps, ask.row, look, now);
        } catch (err) {
          logger.warn(
            `Could not settle storage object ${ask.row.key}: ${String(err)}`,
          );
          return 'left';
        }
      },
    );
    for (const verdict of verdicts) {
      if (verdict === 'removed') {
        result.removed += 1;
        result.settled += 1;
      } else if (verdict === 'counted') {
        result.counted += 1;
        result.settled += 1;
      } else if (verdict === 'looked') result.settled += 1;
      else if (verdict === 'left') result.left += 1;
    }
    if (rows.length < batch) break;
  }
  return result;
}

/** Runs `fn` over `items`, at most `limit` at a time, keeping the order of the results. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const at = next++;
      out[at] = await fn(items[at]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return out;
}

/**
 * Whether the bucket holds the row's file. Only a definite 404 or 403 means
 * `absent`; any other failure is the bucket being unreachable, which is
 * `unknown`: nobody may conclude "not there" from an outage.
 */
async function bucketHolds(
  deps: LateSweepDeps,
  row: SweepRow,
): Promise<'present' | 'absent' | 'unknown'> {
  const { client, bucket, logger } = deps;
  try {
    await client!.send(new HeadObjectCommand({ Bucket: bucket, Key: row.key }));
    return 'present';
  } catch (err) {
    const status = statusOf(err);
    if (status === 404 || status === 403) return 'absent';
    logger.warn(`Could not check storage object ${row.key}: ${String(err)}`);
    return 'unknown';
  }
}

/** The file has not arrived: record that this look happened. */
async function recordLook(
  deps: LateSweepDeps,
  row: SweepRow,
  look: Look,
  now: Date,
): Promise<Verdict> {
  const done = await deps.prisma.storageObject.updateMany({
    where: { id: row.id, status: 'abandoned', [LOOK_GUARD[look]]: null },
    data: lookData(look, row, now),
  });
  // Another sweep recorded it first: nothing of ours to count.
  return done.count > 0 ? 'looked' : 'skipped';
}

/**
 * The file is in the bucket. Under the person's lock, read the row again and
 * decide: count the file (the person never released it, or a listing uses it)
 * or delete it (released, used by no listing).
 */
async function settleFile(
  deps: LateSweepDeps,
  row: SweepRow,
  look: Look,
  now: Date,
): Promise<Verdict> {
  const { client, bucket, prisma, logger } = deps;
  return prisma.$transaction(async (tx): Promise<Verdict> => {
    await lockStorageQuota(tx, row.wawuUserId);
    const fresh = await tx.storageObject.findUnique({
      where: { id: row.id },
      select: { status: true, releasedAt: true, sweptRemovedAt: true },
    });
    // Not ours any more: counted by a confirm, or removed by another sweep.
    if (!fresh || fresh.status !== 'abandoned' || fresh.sweptRemovedAt) {
      return 'skipped';
    }
    const claimed = await isClaimed(tx, row.key);

    if (!fresh.releasedAt || claimed) {
      // The file counts. A row the person never released is theirs to keep
      // (their upload took longer than the give-up time), and a file a listing
      // uses is never deleted, so what stays is counted.
      const counted = await tx.storageObject.updateMany({
        where: { id: row.id, status: 'abandoned' },
        data: {
          status: 'confirmed',
          confirmedAt: now,
          ...lookData(look, row, now),
        },
      });
      if (counted.count === 0) return 'skipped';
      if (fresh.releasedAt) {
        logger.warn(
          `Counted storage object ${row.key}: the person released it, but a listing uses it.`,
        );
      } else {
        logger.log(`Counted late storage object ${row.key}: never released.`);
      }
      return 'counted';
    }

    try {
      await client!.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: row.key }),
      );
    } catch (err) {
      if (statusOf(err) !== 404) {
        logger.warn(
          `Could not remove late storage object ${row.key}: ${String(err)}`,
        );
        return 'left';
      }
    }
    const removed = await tx.storageObject.updateMany({
      where: { id: row.id, status: 'abandoned', sweptRemovedAt: null },
      data: { sweptRemovedAt: now, ...lookData(look, row, now) },
    });
    if (removed.count === 0) return 'skipped';
    logger.log(`Removed late storage object ${row.key} of a given-up upload.`);
    return 'removed';
  }, LOCKED_TX);
}
