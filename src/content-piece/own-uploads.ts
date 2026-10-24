import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { lockStorageQuota } from '../storage/storage-lock';

/**
 * Whether every key in `keys` is a file this person uploaded and still holds: a `StorageObject` row of theirs that is not
 * abandoned and not being removed (the chat attachment rule). A claim on a key, like a listing's file or a photo-set
 * frame, so it runs under the same storage lock as a create (ME-04 round 5): a release or the sweep that is deciding about
 * the key finishes first, and a key released a moment ago is seen here as released. Refuses with `message` otherwise.
 */
export async function assertOwnUploadsUsable(
  tx: Prisma.TransactionClient,
  keys: string[],
  ownerWawuId: string,
  message: string,
): Promise<void> {
  await lockStorageQuota(tx, ownerWawuId);
  const rows = await tx.storageObject.findMany({
    where: {
      key: { in: keys },
      wawuUserId: ownerWawuId,
      status: { not: 'abandoned' },
      removingAt: null,
    },
    select: { key: true },
  });
  const found = new Set(rows.map((r) => r.key));
  if (!keys.every((k) => found.has(k))) throw new BadRequestException(message);
}
