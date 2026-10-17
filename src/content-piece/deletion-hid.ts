import { NotFoundException } from '@nestjs/common';
import type { ContentPiece } from '../../generated/prisma/client';
import type { PrismaService } from '../common/prisma/prisma.service';
import { DELETED_CREATOR_ID } from './deleted-creator';

type Db = Pick<
  PrismaService,
  'accountDeletionContent' | 'purchase' | 'contentPiece'
>;

/** What the three checks below need to know about a piece. */
type PieceRef = { id: string; status: string; creatorWawuId: string };

/**
 * SETTINGS-06 rounds 8 and 9 (lead rulings, 17 Oct 2026). "Buyers keep what
 * they paid for" holds from the moment of DELETE, not only after the purge,
 * and only for a piece that was LIVE when the deletion started. A piece "a
 * deletion hid" (and that its buyers may therefore still open) is a piece with
 * status `removed` that is named by an `AccountDeletionContent` row whose
 * `priorStatus` is `live`.
 *
 * The row is looked up by the piece alone, never under the creator id the
 * caller read: the purge re-keys the piece to the deleted account and a cancel
 * restores it, both while a request may be half way through (round 9, R8-1).
 * The purge moves the row to the deleted account in the same transaction that
 * re-keys the piece, so the row is always there to find. A request that still
 * misses it (a cancel took it, or a purge from before this fix) reads the
 * piece again and decides on what it is now:
 *   - gone, or no longer `removed` (a cancel restored it): not hidden, and the
 *     caller carries on with the piece as it is now;
 *   - `removed` and already re-keyed to the deleted account: the purge ran,
 *     and it is the buyers' (a piece the purge stripped always keeps a row
 *     with a status other than `live`, so it never gets here);
 *   - anything else: a piece taken down by its creator or an admin, which
 *     stays gone for everyone, as it always was.
 * A piece that was removed, rejected or pending before the deletion has a row
 * (or none) whose `priorStatus` is not `live`: a deletion never undoes a
 * takedown.
 */
export async function readHidden(
  db: Db,
  piece: ContentPiece,
): Promise<{ piece: ContentPiece | null; hidden: boolean }> {
  if (piece.status !== 'removed') return { piece, hidden: false };
  const marker = await db.accountDeletionContent.findFirst({
    where: { contentPieceId: piece.id },
    select: { priorStatus: true },
  });
  if (marker) return { piece, hidden: marker.priorStatus === 'live' };
  const now = await db.contentPiece.findUnique({ where: { id: piece.id } });
  if (!now || now.status !== 'removed') return { piece: now, hidden: false };
  return { piece: now, hidden: now.creatorWawuId === DELETED_CREATOR_ID };
}

/** The same question for a caller that holds only a few columns and needs a yes or no. */
export async function hiddenByDeletion(
  db: Db,
  piece: PieceRef,
): Promise<boolean> {
  if (piece.status !== 'removed') return false;
  const marker = await db.accountDeletionContent.findFirst({
    where: { contentPieceId: piece.id },
    select: { priorStatus: true },
  });
  if (marker) return marker.priorStatus === 'live';
  const now = await db.contentPiece.findUnique({
    where: { id: piece.id },
    select: { status: true, creatorWawuId: true },
  });
  return (
    now !== null &&
    now.status === 'removed' &&
    now.creatorWawuId === DELETED_CREATOR_ID
  );
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
  piece: PieceRef,
  viewerWawuId: string | undefined,
  message: string,
): Promise<void> {
  if (!(await hiddenByDeletion(db, piece))) return;
  if (await hasBoughtContent(db, piece.id, viewerWawuId)) return;
  throw new NotFoundException(message);
}
