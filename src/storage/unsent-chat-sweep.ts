import type { Logger } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { CHAT_UPLOAD_FOLDERS } from '../chat/chat-limits';
import { releaseOwnUpload, type ReleaseDeps } from './upload-release';

/**
 * FIX-104 round 2: a chat file that landed and was never sent.
 *
 * A photo, video or PDF is uploaded before its message is sent. When the send
 * fails for good (the person leaves the failed bubble, closes the app, or
 * never comes back), the file is confirmed and counted, and no message carries
 * it. The app gives it back at once when the person taps Delete
 * (POST /uploads/release), and this sweep gives it back for everyone else:
 * every confirmed file in a chat folder that no message carries (a one-to-one
 * chat's, or a line on a legal matter's chat: R2-LEGAL3) is released
 * (the same steps a release takes, so the file is deleted from the bucket and
 * stops counting) once it is UNSENT_CHAT_UPLOAD_HOURS old.
 *
 * Why a day: the person's failed bubble stays on screen for as long as they
 * keep the chat open, and Try again must still find its file. A file a message
 * carries is never touched, and a file the sweep gives back that the person
 * then tries to send answers "That attachment was not uploaded for a chat.
 * Upload it again." (the app uploads it again).
 *
 * Safe to run at any time and from several Hubs at once: each file goes
 * through releaseOwnUpload, which decides under the person's storage lock and
 * re-reads the row there (a message created a moment earlier is seen, and the
 * file kept). A bucket that cannot be reached leaves the row for the next run.
 */
export const UNSENT_CHAT_UPLOAD_HOURS = 24;

export interface UnsentChatSweepOptions {
  /** Sweep only this person's files (a spec). */
  wawuId?: string;
  /** The clock; a spec passes its own. */
  now?: Date;
  /** Files looked at together. */
  batch?: number;
  /** Passes one run makes at most. */
  maxBatches?: number;
}

export interface UnsentChatSweepResult {
  /** Files given back: deleted from the bucket and no longer counted. */
  released: number;
  /** Files it could not give back this run (bucket down, a message appeared): they are looked at again next run. */
  left: number;
}

interface UnsentChatFile {
  id: string;
  key: string;
  wawuUserId: string;
}

export async function sweepUnsentChatUploads(
  deps: ReleaseDeps,
  opts: UnsentChatSweepOptions = {},
): Promise<UnsentChatSweepResult> {
  const { client, prisma, logger } = deps;
  const result: UnsentChatSweepResult = { released: 0, left: 0 };
  if (!client) return result;

  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - UNSENT_CHAT_UPLOAD_HOURS * 3_600_000);
  const batch = opts.batch ?? 50;
  const maxBatches = opts.maxBatches ?? 10;
  const folders = [...CHAT_UPLOAD_FOLDERS];
  // Files left for the next run are not looked at again in this one.
  const asked: string[] = [];

  for (let pass = 0; pass < maxBatches; pass++) {
    // Confirmed (landed and counted), not given up and not being removed, in a
    // chat folder, old enough, and carried by no message.
    const rows = await prisma.$queryRaw<UnsentChatFile[]>(Prisma.sql`
      SELECT s."id", s."key", s."wawuUserId"
      FROM "StorageObject" s
      WHERE s."status" = 'confirmed'
        AND s."folder" IN (${Prisma.join(folders)})
        AND s."releasedAt" IS NULL
        AND s."removingAt" IS NULL
        AND s."createdAt" < ${cutoff}
        ${opts.wawuId ? Prisma.sql`AND s."wawuUserId" = ${opts.wawuId}` : Prisma.empty}
        ${asked.length > 0 ? Prisma.sql`AND s."id" NOT IN (${Prisma.join(asked)})` : Prisma.empty}
        AND NOT EXISTS (
          SELECT 1 FROM "ChatMessage" m WHERE m."attachmentKey" = s."key"
        )
        AND NOT EXISTS (
          SELECT 1 FROM "LegalChatMessage" l WHERE l."attachmentKey" = s."key"
        )
      ORDER BY s."createdAt" ASC
      LIMIT ${batch}
    `);
    if (rows.length === 0) break;
    asked.push(...rows.map((row) => row.id));

    for (const row of rows) {
      if (await giveBack(deps, row, logger)) result.released += 1;
      else result.left += 1;
    }
    if (rows.length < batch) break;
  }
  return result;
}

async function giveBack(
  deps: ReleaseDeps,
  row: UnsentChatFile,
  logger: Logger,
): Promise<boolean> {
  try {
    await releaseOwnUpload(deps, row.wawuUserId, row.key);
    return true;
  } catch (err) {
    // A message that appeared since the look (409), a file the bucket would not
    // delete (503), a person busy with their own uploads (429): next run.
    logger.warn(
      `Could not give back unsent chat file ${row.key}: ${String(err)}`,
    );
    return false;
  }
}
