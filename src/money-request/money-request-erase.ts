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
 *   so is every copy of it that the payer's send left behind: the send's own
 *   note, the note on its ledger rows (the payer's transaction list reads
 *   it), and the note inside the answer stored for the payer's
 *   Idempotency-Key (a repeat of the key replays that answer). A paid request
 *   keeps its money record without the words.
 *
 * It reads and writes this database only. Safe to run again: the second run
 * finds nothing left to change. The payer's side needs nothing here: a request
 * is the asker's, so it stays for them when the payer is erased.
 */
export async function eraseAskerRequests(
  prisma: PrismaService,
  askerWawuId: string,
): Promise<{
  closed: number;
  memosCleared: number;
  notesCleared: number;
  ledgerNotesCleared: number;
  answersBlanked: number;
}> {
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
  // The send's ledger rows (the payer's out row and the asker's in row) were
  // written with the same note, found by the send they belong to.
  const ledger =
    sendIds.length === 0
      ? { count: 0 }
      : await prisma.fintavaLedgerEntry.updateMany({
          where: { transferId: { in: sendIds }, note: { not: null } },
          data: { note: null },
        });
  return {
    closed,
    memosCleared: memos.count,
    notesCleared: notes.count,
    ledgerNotesCleared: ledger.count,
    answersBlanked: await blankStoredAnswers(prisma, sendIds),
  };
}

/**
 * The pay answer stored for the payer's Idempotency-Key is the receipt as it
 * was sent, kept as text for the key's retention period and replayed for a
 * repeat of the key. Its `note` is the asker's memo, so it is set to null
 * here and nothing else in the text is touched. A key is found by the send it
 * made (`resourceId`); one with no answer yet has nothing to blank. Safe to
 * run again: an answer already blank is left as it is.
 */
async function blankStoredAnswers(
  prisma: PrismaService,
  sendIds: string[],
): Promise<number> {
  if (sendIds.length === 0) return 0;
  const keys = await prisma.moneyIdempotencyKey.findMany({
    where: { resourceId: { in: sendIds }, responseBody: { not: null } },
    select: {
      wawuUserId: true,
      method: true,
      route: true,
      key: true,
      responseBody: true,
    },
  });
  let blanked = 0;
  for (const k of keys) {
    const next = withoutNote(k.responseBody);
    if (next === null) continue;
    const { count } = await prisma.moneyIdempotencyKey.updateMany({
      where: {
        wawuUserId: k.wawuUserId,
        method: k.method,
        route: k.route,
        key: k.key,
        responseBody: k.responseBody,
      },
      data: { responseBody: next },
    });
    blanked += count;
  }
  return blanked;
}

/** The stored answer with `data.note` null, or null when it holds no note. */
function withoutNote(stored: string | null): string | null {
  if (!stored) return null;
  let answer: unknown;
  try {
    answer = JSON.parse(stored);
  } catch {
    return null;
  }
  const data = (answer as { data?: unknown } | null)?.data;
  if (
    typeof data !== 'object' ||
    data === null ||
    typeof (data as { note?: unknown }).note !== 'string'
  ) {
    return null;
  }
  (data as { note: string | null }).note = null;
  return JSON.stringify(answer);
}
