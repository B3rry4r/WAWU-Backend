import type { PrismaService } from '../../common/prisma/prisma.service';
import type { Prisma } from '../../../generated/prisma/client';

/**
 * Nuvion's review refused a document the person sent (task NUV-03 round 2,
 * D1). The refusal is kept on the document's own row (`NuvionDocument.
 * reviewRefusedAt`), not only in the entity's word for it: that word is
 * Nuvion's current reading, and Nuvion may answer a correction of the
 * person's details (`PATCH /individual-entities/{id}`) with the check back
 * at `pending`. Without this the refused file would read as standing again,
 * and the opening would be sent a second time with the same file.
 *
 * Called wherever the entity's document words are written (the delivery
 * handler, the correction) and by the documents flow when it reads them, so
 * a refusal is on the row before anything can overwrite the word. It is
 * safe to call any number of times: a row already marked keeps its time.
 *
 * Only an upload that was in before the review decided is refused: a file
 * the person sent after the decision (a replacement) is not about the old
 * refusal. A refusal word with no decision time on record counts for the
 * file on hand.
 */

/** The words Nuvion uses for a check that did not pass. */
const NOT_PASSED = new Set([
  'rejected',
  'failed',
  'declined',
  'not-approved',
  'not_approved',
  'invalid',
  'unverified',
]);

export function documentWordNotPassed(word: string | null): boolean {
  return word !== null && NOT_PASSED.has(word.trim().toLowerCase());
}

/** What of the entity decides it: the words, and when the review decided. */
export interface DocumentWords {
  decidedAt: Date | null;
  documentStatus: string | null;
  addressProofStatus: string | null;
}

/** A client that can update document rows: the service, or a transaction. */
export type DocumentRowsClient = Pick<
  PrismaService | Prisma.TransactionClient,
  'nuvionDocument'
>;

export async function noteDocumentRefusals(
  db: DocumentRowsClient,
  wawuUserId: string,
  words: DocumentWords,
  now: Date,
): Promise<void> {
  const kinds: Array<['identity' | 'proof_of_address', string | null]> = [
    ['identity', words.documentStatus],
    ['proof_of_address', words.addressProofStatus],
  ];
  for (const [kind, word] of kinds) {
    if (!documentWordNotPassed(word)) continue;
    await db.nuvionDocument.updateMany({
      where: {
        wawuUserId,
        kind,
        state: 'uploaded',
        reviewRefusedAt: null,
        ...(words.decidedAt === null
          ? {}
          : { uploadedAt: { lte: words.decidedAt } }),
      },
      data: { reviewRefusedAt: now },
    });
  }
}
