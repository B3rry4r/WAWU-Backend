import type { Prisma } from '../../generated/prisma/client';

/**
 * WEB-HOLD (R-126, owner, 3 Nov 2026): the site collects contents first. A piece made by the new web upload flow
 * (`X-Wawu-Client: site`, stored as `ContentPiece.uploadedVia = 'site'`) is reviewed as usual, but when a moderator approves it
 * it goes live only if its creator has an open wallet. Otherwise it is "approved, waiting for wallet": status stays `pending`
 * (so it is in no feed, explore, search, profile or public read, none of which changed) and `heldForWalletAt` is set. The
 * moment the creator's wallet is recorded, every piece held for them goes live at once.
 *
 * Pieces from the app and from today's web are never held: `uploadedVia` is null for them.
 */

/** What `uploadedVia` holds for a piece from the new web upload flow. */
export const UPLOADED_VIA_SITE = 'site';

/** The one word the creator's own reads carry in `waitingFor` while a piece is held. */
export const WAITING_FOR_WALLET = 'wallet';

type Db = Pick<
  Prisma.TransactionClient,
  'fintavaWallet' | 'contentPiece' | '$executeRaw'
>;

/**
 * Serialises "a moderator approves a piece of this creator" against "this creator's wallet is recorded", so a piece is never
 * left held after the wallet is already there. Both sides take it inside their own transaction, then read what the other
 * committed. It is held only for those few statements; nothing under it calls out of the database.
 */
async function lockCreator(tx: Db, wawuUserId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'content-wallet-hold:' + wawuUserId}))`;
}

/**
 * Whether the creator's wallet is open: a row in the wallet table, which is the first (and for a naira wallet the only) check
 * of `WalletGate.requireOpen` (src/money/gate/wallet-gate.ts). Written as a plain read so the content code never reaches the
 * wallet provider.
 */
async function walletIsOpen(tx: Db, wawuUserId: string): Promise<boolean> {
  const row = await tx.fintavaWallet.findUnique({
    where: { wawuUserId },
    select: { wawuUserId: true },
  });
  return row !== null;
}

/**
 * Called by a moderator's approval, inside its transaction, for a piece that is being approved. Returns `held` when the piece
 * came from the web flow and its creator has no open wallet: the caller then keeps it pending and sets `heldForWalletAt`.
 */
export async function approvalOutcome(
  tx: Db,
  piece: { creatorWawuId: string; uploadedVia: string | null },
): Promise<'live' | 'held'> {
  if (piece.uploadedVia !== UPLOADED_VIA_SITE) return 'live';
  await lockCreator(tx, piece.creatorWawuId);
  return (await walletIsOpen(tx, piece.creatorWawuId)) ? 'live' : 'held';
}

/**
 * Called inside the transaction that records a creator's wallet. Every piece held for them goes live at once. Idempotent: it
 * only touches rows still held, so a second call (a repeated provider event, two servers) changes nothing.
 */
export async function releaseHeldPieces(
  tx: Db,
  wawuUserId: string,
): Promise<number> {
  await lockCreator(tx, wawuUserId);
  const released = await tx.contentPiece.updateMany({
    where: {
      creatorWawuId: wawuUserId,
      status: 'pending',
      heldForWalletAt: { not: null },
    },
    data: { status: 'live', heldForWalletAt: null },
  });
  return released.count;
}

/** `waitingFor` on the creator's own view of a piece. */
export function waitingForOf(piece: {
  status: string;
  heldForWalletAt: Date | null;
}): typeof WAITING_FOR_WALLET | null {
  return piece.status === 'pending' && piece.heldForWalletAt !== null
    ? WAITING_FOR_WALLET
    : null;
}
