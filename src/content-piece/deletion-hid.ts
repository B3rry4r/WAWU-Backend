import { NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../common/prisma/prisma.service';
import { DELETED_CREATOR_ID } from './deleted-creator';

type Db = Pick<PrismaService, 'accountDeletionContent' | 'purchase'>;

/**
 * SETTINGS-06 round 8 (lead ruling, 17 Oct 2026): "buyers keep what they paid
 * for" holds from the moment of DELETE, not only after the purge. A piece "a
 * deletion hid" is a piece with status `removed` that either
 *   - has the deleted-account id as its creator (`DELETED_CREATOR_ID`: the
 *     purge ran), or
 *   - is named by an `AccountDeletionContent` row (the deletion hid it, and a
 *     cancel would put it back; the purge clears these rows only after it has
 *     re-keyed the sold pieces, so there is no gap between the two).
 * Any other removed piece (taken down by its creator or an admin) is not one:
 * it stays gone for everyone, as it always was.
 */
export async function hiddenByDeletion(
  db: Db,
  piece: { id: string; status: string; creatorWawuId: string },
): Promise<boolean> {
  if (piece.status !== 'removed') return false;
  if (piece.creatorWawuId === DELETED_CREATOR_ID) return true;
  const marker = await db.accountDeletionContent.findUnique({
    where: {
      wawuUserId_contentPieceId: {
        wawuUserId: piece.creatorWawuId,
        contentPieceId: piece.id,
      },
    },
    select: { id: true },
  });
  return marker !== null;
}

/** True when this person has a completed paid purchase of the piece. */
export async function hasBoughtContent(
  db: Db,
  contentId: string,
  buyerWawuId: string | undefined,
): Promise<boolean> {
  if (!buyerWawuId) return false;
  const row = await db.purchase.findFirst({
    where: {
      contentId,
      buyerWawuId,
      type: 'content',
      status: 'completed',
    },
    select: { id: true },
  });
  return row !== null;
}

/**
 * For the routes a non-buyer must not use on a piece a deletion hid (read or
 * post comments, save): the same 404 as a piece that is not there. A piece
 * that is not hidden by a deletion is not looked at, so every other removed
 * piece answers exactly as before.
 */
export async function assertBuyerOnlyIfHidden(
  db: Db,
  piece: { id: string; status: string; creatorWawuId: string },
  viewerWawuId: string | undefined,
  message: string,
): Promise<void> {
  if (!(await hiddenByDeletion(db, piece))) return;
  if (await hasBoughtContent(db, piece.id, viewerWawuId)) return;
  throw new NotFoundException(message);
}
