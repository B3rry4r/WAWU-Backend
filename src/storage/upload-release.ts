import {
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
  type Logger,
} from '@nestjs/common';
import type { S3Client } from '@aws-sdk/client-s3';
import type { Prisma } from '../../generated/prisma/client';
import type { PrismaService } from '../common/prisma/prisma.service';
import { deleteFromBucket } from './bucket-delete';
import {
  LOCKED_TX,
  inPersonsTurn,
  lockStorageQuota,
  removalInFlight,
} from './storage-lock';

/**
 * ME-04 round 2: a person who takes a file out of an unfinished draft gives
 * its space back. A presigned upload is counted the moment it is reserved, and
 * until now nothing but the reconcile job ever uncounted one, so a wrong pick
 * burned storage for good.
 *
 * `POST /uploads/release` is for an upload that is the caller's own and that no
 * listing has claimed yet. It deletes the object from the bucket and marks the
 * row `abandoned`, which is the state the usage sum already leaves out. The row
 * is kept (not deleted) so a repeated call finds it and answers the same way.
 *
 * What it answers when it cannot help says nothing about whether the key
 * exists: another person's key, a key that was never reserved and a key in a
 * folder this route does not handle all get the same 404.
 */
export const UPLOAD_NOT_FOUND = 'That upload was not found.';

export interface ReleaseDeps {
  client: S3Client | null;
  bucket: string;
  /** The folders whose files count against the allowance (the only ones this releases). */
  folders: readonly string[];
  prisma: PrismaService;
  logger: Logger;
}

/**
 * Whether a listing already points at the object. A content piece stores the
 * `fileUrl` the presign answered with (or the key itself), a photo set stores
 * one per frame, and the key is a random id inside either, so a text match on
 * the key finds both forms. Every piece counts, whoever made it and whatever
 * its status: a removed piece still holds its row.
 */
export async function isClaimed(
  prisma: Pick<Prisma.TransactionClient, 'contentPiece' | 'contentFrame'>,
  key: string,
): Promise<boolean> {
  const [piece, frame] = await Promise.all([
    prisma.contentPiece.findFirst({
      where: {
        OR: [
          { previewAssetUrl: { contains: key } },
          { fullAssetUrl: { contains: key } },
        ],
      },
      select: { id: true },
    }),
    prisma.contentFrame.findFirst({
      where: { url: { contains: key } },
      select: { id: true },
    }),
  ]);
  return Boolean(piece ?? frame);
}

const TRY_AGAIN =
  'Could not remove that file right now. Try again in a moment.';

/**
 * Three short steps, and the bucket is called in none of them that holds
 * anything (ME-04 round 5, the lead's rule: never hold a transaction, a pooled
 * connection or the person's lock across a network call).
 *
 * 1. Under the person's storage lock (storage-lock.ts), the same one a confirm
 *    takes to count a file and a listing takes to name it: read the row, check
 *    that no listing uses the key, and mark it released and being removed
 *    (`abandoned`, `releasedAt`, `removingAt`). Commit. From here a listing, a
 *    frame or a confirm on the key is refused or answers `abandoned`, so
 *    nothing can claim a file that is about to be deleted.
 * 2. Holding nothing: ask the bucket to delete the object.
 * 3. Under the lock again: clear the mark. If the bucket refused the delete,
 *    put the row back as it was (still counted, the same call can be made
 *    again). If no answer came (a timeout), the delete may still happen, so
 *    the row stays given up and the sweep settles it.
 */
export async function releaseOwnUpload(
  deps: ReleaseDeps,
  wawuId: string,
  key: string,
): Promise<{ released: true }> {
  const { client, bucket, folders, prisma, logger } = deps;
  if (!client) {
    throw new ServiceUnavailableException(
      'File uploads are not available on this environment yet.',
    );
  }

  // Each part runs in the person's turn (storage-lock.ts), so a burst of
  // releases waits in memory and not on pooled connections (ME-04 round 6).
  // The first part may be refused with 429 (nothing is changed yet); the
  // second is never refused, because the delete it records has been asked for.
  const claim = await inPersonsTurn(wawuId, () =>
    prisma.$transaction(async (tx) => {
      await lockStorageQuota(tx, wawuId);
      const row = await tx.storageObject.findUnique({ where: { key } });
      if (!row || row.wawuUserId !== wawuId || !folders.includes(row.folder)) {
        throw new NotFoundException(UPLOAD_NOT_FOUND);
      }
      if (await isClaimed(tx, key)) {
        throw new ConflictException({
          message: 'That file is already part of a listing.',
          reason: { code: 'upload_claimed' },
        });
      }
      // Another removal of this file is in flight (a second tap, the sweep): it
      // owns the row until it ends.
      if (removalInFlight(row))
        throw new ServiceUnavailableException(TRY_AGAIN);

      // `releasedAt` is what keeps the row released: POST /uploads/confirm never
      // counts it again if a late file lands (the PUT link stays valid for its
      // whole life after this call), and the sweep removes that file once the
      // link has expired (late-file-sweep.ts). A row already given up some other
      // way (a settled, missing upload) is marked too: the person has released
      // it now. A row confirmed a moment ago is released too, because the lock
      // made that confirm finish first.
      const at = new Date();
      await tx.storageObject.update({
        where: { id: row.id },
        data: {
          status: 'abandoned',
          releasedAt: row.releasedAt ?? at,
          removingAt: at,
        },
      });
      return {
        id: row.id,
        at,
        before: {
          status: row.status,
          confirmedAt: row.confirmedAt,
          releasedAt: row.releasedAt,
        },
      };
    }, LOCKED_TX),
  );

  const outcome = await deleteFromBucket(client, bucket, key);
  if (outcome.result !== 'gone') {
    logger.warn(
      `Could not delete storage object ${key}: ${String(outcome.error)}`,
    );
  }

  await inPersonsTurn(
    wawuId,
    () =>
      prisma.$transaction(async (tx) => {
        await lockStorageQuota(tx, wawuId);
        // Guarded on our own mark: a row somebody else has since taken over (the
        // sweep, after this mark went stale) is not ours to change.
        await tx.storageObject.updateMany({
          where: { id: claim.id, removingAt: claim.at },
          data:
            outcome.result === 'failed'
              ? { ...claim.before, removingAt: null }
              : { removingAt: null },
        });
      }, LOCKED_TX),
    { finishing: true },
  );

  if (outcome.result !== 'gone')
    throw new ServiceUnavailableException(TRY_AGAIN);
  return { released: true as const };
}
