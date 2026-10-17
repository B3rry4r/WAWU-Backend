import type { PrismaService } from '../common/prisma/prisma.service';

/**
 * What the account purge does to the money requests a person ASKED for
 * (INBOX-15 round 2). Their chat bubble goes with them (ChatMessage is
 * authored), so the request must not outlive it as an open question or as
 * their words:
 *
 * - every request of theirs that is pending and not being paid is cancelled
 *   (nobody can start a payment for it any more, and the person who was asked
 *   sees it closed);
 * - a request being paid is left to its send: it becomes `paid` when the send
 *   completes, and is closed when the send fails (`MoneyRequestService.settleOne`
 *   sees the asker's deletion row);
 * - the reason they wrote (`memo`) is cleared on every request they made, and
 *   so is the copy of it that the payer's send carries as its note, so a paid
 *   request keeps its money record without the words.
 *
 * It reads and writes this database only. Safe to run again: the second run
 * finds nothing left to change. The payer's side needs nothing here: a request
 * is the asker's, so it stays for them when the payer is erased.
 */
export async function eraseAskerRequests(
  prisma: PrismaService,
  askerWawuId: string,
): Promise<{ closed: number; memosCleared: number; notesCleared: number }> {
  let closed = 0;
  // A bound, so a request that keeps changing under it cannot hold a purge.
  for (let pass = 0; pass < 1000; pass += 1) {
    const open = await prisma.moneyRequest.findMany({
      where: {
        requesterWawuId: askerWawuId,
        status: 'pending',
        transferId: null,
      },
      orderBy: { createdAt: 'asc' },
      take: 200,
      select: { id: true },
    });
    if (open.length === 0) break;
    // One conditional update for the lot: a payment's claim (which sets
    // transferId) that gets in first takes its request out of this set.
    const { count } = await prisma.moneyRequest.updateMany({
      where: {
        id: { in: open.map((r) => r.id) },
        requesterWawuId: askerWawuId,
        status: 'pending',
        transferId: null,
      },
      data: { status: 'cancelled', changedAt: new Date(), memo: null },
    });
    closed += count;
    // Nothing changed although rows matched a moment ago: they were answered
    // in between, so the next look no longer finds them.
  }
  const memos = await prisma.moneyRequest.updateMany({
    where: { requesterWawuId: askerWawuId, memo: { not: null } },
    data: { memo: null },
  });
  const sends = await prisma.moneyRequest.findMany({
    where: { requesterWawuId: askerWawuId, transferId: { not: null } },
    select: { transferId: true },
  });
  const sendIds = sends.flatMap((s) => (s.transferId ? [s.transferId] : []));
  const notes =
    sendIds.length === 0
      ? { count: 0 }
      : await prisma.walletTransfer.updateMany({
          where: { id: { in: sendIds }, note: { not: null } },
          data: { note: null },
        });
  return {
    closed,
    memosCleared: memos.count,
    notesCleared: notes.count,
  };
}
