import {
  DeleteObjectCommand,
  HeadObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import type { Logger } from '@nestjs/common';
import type { PrismaService } from '../common/prisma/prisma.service';
import { isClaimed } from './upload-release';

/**
 * ME-04 round 3: a file that lands after its upload was given up.
 *
 * The PUT link a presign hands out stays valid for its whole life (300 s) no
 * matter what the Hub has since done with the row. So a person can presign
 * (counted), send the file, release it (uncounted, object deleted) and send
 * the same file again with the same link: the object is back in the bucket,
 * its row is `abandoned`, and nothing counts it. Repeated, that stores without
 * a ceiling.
 *
 * This is the Hub's own sweep for that. It looks at every `abandoned` row
 * (released by the person, or settled as never arrived) in a content folder
 * whose link has expired, with a margin on top for a slow upload that began
 * just before it did. If the object is in the bucket it is deleted, and the row
 * records that the sweep did (`sweptAt`, and `sweptRemovedAt` for a delete).
 *
 * Rules it keeps:
 * - A claimed key is never touched: a listing that uses the file keeps it
 *   (the same check POST /uploads/release makes).
 * - Only a definite answer settles a row. A bucket that cannot be asked, or a
 *   delete it refuses, leaves the row unmarked for the next pass.
 * - Every write is guarded on the row still being `abandoned` and unswept, so
 *   two Hubs sweeping at once, or a person confirming meanwhile, cannot make it
 *   delete a file that is counted.
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
  /** Rows the sweep settled (removed a file, found none, or found it claimed). */
  settled: number;
  /** Files it deleted. */
  removed: number;
  /** Rows it could not settle (bucket down, delete refused): they stay for the next pass. */
  left: number;
}

type Verdict = 'removed' | 'settled' | 'left';

const DEFAULT_BATCH = 50;
const DEFAULT_MAX_BATCHES = 10;

function statusOf(err: unknown): number | undefined {
  return (err as { $metadata?: { httpStatusCode?: number } }).$metadata
    ?.httpStatusCode;
}

export async function sweepLateFiles(
  deps: LateSweepDeps,
  opts: LateSweepOptions,
): Promise<LateSweepResult> {
  const { client, folders, prisma } = deps;
  const result: LateSweepResult = { settled: 0, removed: 0, left: 0 };
  if (!client) return result;

  const now = opts.now ?? new Date();
  const cutoff = new Date(
    now.getTime() - (opts.linkSeconds + opts.marginSeconds) * 1000,
  );
  const batch = opts.batch ?? DEFAULT_BATCH;
  const maxBatches = opts.maxBatches ?? DEFAULT_MAX_BATCHES;
  // Rows left for the next pass are not asked again in this one, so the loop
  // ends even during an outage.
  const asked: string[] = [];

  for (let pass = 0; pass < maxBatches; pass++) {
    const rows = await prisma.storageObject.findMany({
      where: {
        status: 'abandoned',
        sweptAt: null,
        folder: { in: [...folders] },
        createdAt: { lt: cutoff },
        ...(opts.wawuId ? { wawuUserId: opts.wawuId } : {}),
        ...(asked.length > 0 ? { id: { notIn: asked } } : {}),
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, key: true },
      take: batch,
    });
    if (rows.length === 0) break;
    asked.push(...rows.map((row) => row.id));

    const verdicts = await Promise.all(
      rows.map((row) => settleOne(deps, row, now)),
    );
    for (const verdict of verdicts) {
      if (verdict === 'removed') {
        result.removed += 1;
        result.settled += 1;
      } else if (verdict === 'settled') result.settled += 1;
      else result.left += 1;
    }
    if (rows.length < batch) break;
  }
  return result;
}

async function settleOne(
  deps: LateSweepDeps,
  row: { id: string; key: string },
  now: Date,
): Promise<Verdict> {
  const { client, bucket, prisma, logger } = deps;
  const mark = (removed: boolean) =>
    prisma.storageObject.updateMany({
      where: { id: row.id, status: 'abandoned', sweptAt: null },
      data: removed ? { sweptAt: now, sweptRemovedAt: now } : { sweptAt: now },
    });

  try {
    await client!.send(new HeadObjectCommand({ Bucket: bucket, Key: row.key }));
  } catch (err) {
    const status = statusOf(err);
    if (status === 404 || status === 403) {
      // Nothing came back after the link expired: this row is done.
      await mark(false);
      return 'settled';
    }
    logger.warn(`Could not check storage object ${row.key}: ${String(err)}`);
    return 'left';
  }

  // The object is there. Look again at the row right before deleting: a person
  // who confirmed meanwhile made it counted, and a listing may have claimed it.
  const fresh = await prisma.storageObject.findUnique({
    where: { id: row.id },
    select: { status: true, sweptAt: true },
  });
  // Not ours any more (counted, or another Hub swept it): nothing to do.
  if (!fresh || fresh.status !== 'abandoned' || fresh.sweptAt) return 'settled';
  if (await isClaimed(prisma, row.key)) {
    // A listing uses this file: it stays, and the row is not asked about again.
    await mark(false);
    return 'settled';
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
  await mark(true);
  logger.log(`Removed late storage object ${row.key} of a given-up upload.`);
  return 'removed';
}
