import type { PrismaService } from '../common/prisma/prisma.service';
import { CHAT_UPLOAD_FOLDERS } from '../chat/chat-limits';

/**
 * The conversation on a person's legal matters (R2-LEGAL3). A legal matter
 * (`LegalRequest`) is the person's own and the purge deletes it, and the
 * thread attached to it (`LegalChatMessage`) is part of the matter: it holds
 * the person's words, the assistant's and the consultant's replies to them,
 * and, since R2-LEGAL3, a line for each file the person sent (the key of a
 * chat upload in `attachmentKey`, and the name of a PDF).
 *
 * The files themselves are chat uploads (`chat/media`, `chat/file`), so the
 * file step of the purge deletes them like any other chat file (FILE_KINDS in
 * purge-files.ts). This step removes what names them. A thread has no user
 * column to delete by, so it is found by the person's matters, and a line that
 * names one of the person's chat uploads is found by that key, so a line that
 * landed after its matter was gone is still removed.
 *
 * Nothing is kept past the deletion: the purge keeps no legal or money record
 * for a retention period (LegalRequest is OWNED, account-data-map.ts). Run it
 * BEFORE the matters are deleted: once they are gone, a retry could not tell
 * which threads were the person's. Safe to run again.
 */
export async function eraseLegalThreads(
  prisma: PrismaService,
  wawuUserId: string,
): Promise<number> {
  const matters = await prisma.legalRequest.findMany({
    where: { wawuUserId },
    select: { id: true },
  });
  const { count } = await prisma.legalChatMessage.deleteMany({
    where: {
      OR: [
        ...(matters.length > 0
          ? [{ legalRequestId: { in: matters.map((m) => m.id) } }]
          : []),
        ...CHAT_UPLOAD_FOLDERS.map((folder) => ({
          attachmentKey: {
            startsWith: `${folder}/${wawuUserId}/`,
            mode: 'insensitive' as const,
          },
        })),
      ],
    },
  });
  return count;
}
