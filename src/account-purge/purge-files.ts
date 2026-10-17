import { Logger } from '@nestjs/common';
import type { PrismaService } from '../common/prisma/prisma.service';
import { objectKeyFrom } from '../storage/storage.service';
import type { StorageRemover } from '../storage/storage-remover';
import { DELETED_CREATOR_ID } from '../content-piece/deleted-creator';

/**
 * The files an account's purge handles (FIX-65). Every file a person uploads
 * is a `StorageObject` row (the uploader's id, the key, the folder), written
 * by `presignUpload` (everything a client or a chat sends) or `putGenerated`
 * (the audio an AI job makes), and the key is always
 * `<folder>/<uploader id>/<uuid>.<ext>`. So the rows ARE the inventory, and the
 * purge walks them.
 *
 * What happens to a file is decided here, once, by its folder:
 *
 *   DELETE  nobody else has a right to it. The object is removed from the
 *           bucket after the database rows that pointed at it are gone, and
 *           only then is its row deleted (a row is the list of what is left, so
 *           a failed or interrupted run finds the rest next time).
 *   OWNER   an identity or verification document WAWU may have to keep for a
 *           time. Whether it must is a legal question for the owner (R-1), so
 *           the purge does NOT delete it: its row is refiled under
 *           DELETED_CREATOR_ID (the key stays findable; the row is no longer
 *           the person's) and the account's `purgeNote` counts it.
 *
 * Two more things are kept, and are not decisions of this table:
 *   - the files of content pieces a buyer paid for (`soldKeys`, SETTINGS-06
 *     round 7, R-50): the purge's sold-content step refiles those rows itself;
 *   - the image of an event that still stands (a host's event whose ticket
 *     money has not been settled is kept, hidden, by EventHostErasureService):
 *     its holders still open it. The row is refiled like an OWNER one.
 *
 * A folder missing from this table is a build failure (purge-files.spec.ts
 * holds it against UPLOAD_FOLDERS, the chat folders and the AI audio folder),
 * so a new kind of upload cannot ship without a decision. At run time an
 * unknown folder is treated as DELETE, as every file was before this task.
 */
export type FileDecision = 'DELETE' | 'OWNER';

export interface FileKind {
  decision: FileDecision;
  /** Who uploads it, which rows point at it, and why it gets this decision. */
  what: string;
}

export const FILE_KINDS: Readonly<Record<string, FileKind>> = {
  'content/preview': {
    decision: 'DELETE',
    what: 'A creator listing preview (ContentPiece.previewAssetUrl). Deleted, except the previews of pieces a buyer paid for that were live when the deletion began (kept for the buyers).',
  },
  'content/full': {
    decision: 'DELETE',
    what: 'A creator listing file and the pictures of a photo set (ContentPiece.fullAssetUrl, ContentFrame.url). Deleted, except those of pieces a buyer paid for that were live when the deletion began (kept for the buyers).',
  },
  'kyc/id-document': {
    decision: 'OWNER',
    what: 'The identity document for the wallet check (KycSubmission.idDocumentUrl). Kept; retention is a legal question for the owner.',
  },
  'service-application/document': {
    decision: 'OWNER',
    what: 'Supporting documents for a CAC, NEPC or partner application (ServiceApplication.documents), which include a valid ID and a signature. Kept for the owner.',
  },
  'professional/document': {
    decision: 'OWNER',
    what: 'A practising licence or qualification for a professional listing (ProfessionalProfile.documents). Evidence WAWU relied on to list the person. Kept for the owner.',
  },
  'legal/document': {
    decision: 'DELETE',
    what: 'What the person attached to a legal matter (LegalIntake.documents, LegalRequest.documents). The matter rows are deleted by the purge already, so the files go with them. Files the legal team uploaded for the person are the team’s own uploads and are not touched.',
  },
  avatars: {
    decision: 'DELETE',
    what: 'Profile picture (UserProfile.avatarUrl).',
  },
  'profile/cover': {
    decision: 'DELETE',
    what: 'Profile cover (UserProfile.coverUrl).',
  },
  'profile/work': {
    decision: 'DELETE',
    what: 'Pictures and video of a featured work (ProfileWork.media).',
  },
  'community/image': {
    decision: 'DELETE',
    what: 'A community cover (Community.imageUrl); the community is the host’s and goes with them.',
  },
  'community/message': {
    decision: 'DELETE',
    what: 'A photo posted in a community (CommunityMessage.imageUrl); the message is the person’s writing and goes.',
  },
  'event/banner': {
    decision: 'DELETE',
    what: 'An event banner (Event.bannerUrl). Deleted, unless an event that still stands shows it.',
  },
  'event/speaker': {
    decision: 'DELETE',
    what: 'A speaker photo (EventSpeaker.photoUrl). Deleted, unless an event that still stands shows it.',
  },
  'chat/media': {
    decision: 'DELETE',
    what: 'A photo or video sent in a chat (ChatMessage.attachmentKey); the person’s messages go, the other person’s stay.',
  },
  'chat/file': {
    decision: 'DELETE',
    what: 'A PDF sent in a chat (ChatMessage.attachmentKey).',
  },
  'ai/voiceover': {
    decision: 'DELETE',
    what: 'The audio an AI voice-over job made for the person (AiToolJob.audioKey).',
  },
};

/** Folders whose files the purge keeps for the owner's ruling. */
export const OWNER_FOLDERS: readonly string[] = Object.entries(FILE_KINDS)
  .filter(([, k]) => k.decision === 'OWNER')
  .map(([folder]) => folder);

/** Folders whose images an event that still stands may show. */
export const EVENT_FOLDERS: readonly string[] = [
  'event/banner',
  'event/speaker',
];

/** Rows read at a time, and the most time one purge spends on files. */
const PAGE = 200;
export const FILE_BUDGET_MS = 40_000;

const logger = new Logger('AccountPurgeFiles');

/** Prisma `where` pieces that match a folder by its column or by the key's start. */
const inFolders = (folders: readonly string[]) => [
  { folder: { in: [...folders] } },
  ...folders.map((f) => ({ key: { startsWith: `${f}/` } })),
];

/**
 * The keys of the person's identity and verification documents that are named
 * by a row about to be deleted, whatever folder the client uploaded them to
 * (a client names the folder at presign; only the folder column says what it
 * was meant for). Read BEFORE those rows go.
 */
export async function findIdentityKeys(
  prisma: PrismaService,
  wawuUserId: string,
): Promise<string[]> {
  const [kyc, verification, applications, professional] = await Promise.all([
    prisma.kycSubmission.findMany({
      where: { wawuUserId },
      select: { idDocumentUrl: true },
    }),
    prisma.verificationSubmission.findMany({
      where: { wawuUserId },
      select: { documents: true },
    }),
    prisma.serviceApplication.findMany({
      where: { applicantWawuId: wawuUserId },
      select: { documents: true },
    }),
    prisma.professionalProfile.findMany({
      where: { wawuUserId },
      select: { documents: true },
    }),
  ]);
  const keys = new Set<string>();
  for (const stored of [
    ...kyc.map((r) => r.idDocumentUrl),
    ...verification.flatMap((r) => r.documents),
    ...applications.flatMap((r) => r.documents),
    ...professional.flatMap((r) => r.documents),
  ]) {
    if (typeof stored === 'string' && stored !== '') {
      keys.add(objectKeyFrom(stored));
    }
  }
  return [...keys];
}

/**
 * Whether the deletion lets files go: its row says the purge is under way
 * (`purging`, or `purged` for a repeat), the 30 days are over and WAWU ID has
 * confirmed the deletion started (SETTINGS-06, SETTINGS-08). The sweep only
 * calls the purge for such a row; this is the same rule held at the one step
 * that cannot be taken back.
 */
async function deletionLetsFilesGo(
  prisma: PrismaService,
  wawuUserId: string,
  now: Date,
): Promise<boolean> {
  const row = await prisma.accountDeletion.findUnique({
    where: { wawuUserId },
    select: { status: true, purgeAfter: true, identityMarkedAt: true },
  });
  return (
    row !== null &&
    (row.status === 'purging' || row.status === 'purged') &&
    row.purgeAfter.getTime() <= now.getTime() &&
    row.identityMarkedAt !== null
  );
}

/** A key in this person's own folder of this bucket: `<folder>/<their id>/...`. */
function namesPerson(key: string, wawuUserId: string): boolean {
  return key.toLowerCase().split('/').includes(wawuUserId.toLowerCase());
}

export interface EraseFilesResult {
  /** `StorageObject` rows deleted (their objects first, when the Hub has a bucket). */
  rowsDeleted: number;
  /** Objects the bucket no longer holds after this run (deleted now, or already absent). */
  objectsRemoved: number;
  /** Identity and verification files kept for the owner (refiled, not deleted). */
  ownerKept: number;
  /** Event images kept because an event that still stands shows them. */
  eventKept: number;
  /** Why some of the person's files are still there, or null when none are. */
  left: string | null;
}

/**
 * The file step of the purge. Call it after every database row that points at
 * a file has been dealt with, with no transaction open.
 *
 * - With a bucket (`remover.isConfigured`): refuses unless the deletion is due
 *   (see `deletionLetsFilesGo`); removes each object, `remover.removeMany`
 *   holding nothing meanwhile, and deletes a row only after its object is
 *   gone. An object that cannot be removed keeps its row and is reported in
 *   `left`; the next pass tries it again. A missing object is not an error.
 *   It stops after FILE_BUDGET_MS and says so in `left`.
 * - Without one (a server with no STORAGE_* has never held an upload): the
 *   rows go, as they always did, and an error is logged if there were any.
 *
 * Idempotent: a second run finds no row under the person and does nothing.
 * Only rows of `wawuUserId` are looked at, and an object whose key does not
 * carry that id in its path is never deleted.
 */
export async function eraseFiles(
  prisma: PrismaService,
  remover: StorageRemover | undefined,
  input: {
    wawuUserId: string;
    /** Keys of the files kept for the buyers of sold content (never touched). */
    soldKeys: readonly string[];
    /** Keys named by the person's identity and verification rows (`findIdentityKeys`). */
    identityKeys: readonly string[];
    now?: Date;
  },
): Promise<EraseFilesResult> {
  const id = input.wawuUserId;
  const out: EraseFilesResult = {
    rowsDeleted: 0,
    objectsRemoved: 0,
    ownerKept: 0,
    eventKept: 0,
    left: null,
  };
  const bucket = remover?.isConfigured ? remover : null;
  if (
    bucket &&
    !(await deletionLetsFilesGo(prisma, id, input.now ?? new Date()))
  ) {
    out.left = 'the deletion is not due yet or WAWU ID has not confirmed it';
    logger.error(
      `Files of ${id} are not removed: the deletion is not due or not confirmed by WAWU ID`,
    );
    return out;
  }

  const notSold =
    input.soldKeys.length > 0 ? { key: { notIn: [...input.soldKeys] } } : {};

  // OWNER: the identity files stay, filed under the deleted account.
  const ownerWhere = [
    ...inFolders(OWNER_FOLDERS),
    ...(input.identityKeys.length > 0
      ? [{ key: { in: [...input.identityKeys] } }]
      : []),
  ];
  out.ownerKept = (
    await prisma.storageObject.updateMany({
      where: { wawuUserId: id, ...notSold, OR: ownerWhere },
      data: { wawuUserId: DELETED_CREATOR_ID },
    })
  ).count;

  // An event that still stands shows its images; they stay with it.
  const eventRows = await prisma.storageObject.findMany({
    where: { wawuUserId: id, ...notSold, OR: inFolders(EVENT_FOLDERS) },
    select: { id: true, key: true },
  });
  const shown = new Set<string>();
  for (let i = 0; i < eventRows.length; i += 50) {
    const keys = eventRows.slice(i, i + 50).map((r) => r.key);
    const [banners, photos] = await Promise.all([
      prisma.event.findMany({
        where: { OR: keys.map((k) => ({ bannerUrl: { contains: k } })) },
        select: { bannerUrl: true },
      }),
      prisma.eventSpeaker.findMany({
        where: { OR: keys.map((k) => ({ photoUrl: { contains: k } })) },
        select: { photoUrl: true },
      }),
    ]);
    for (const k of keys) {
      if (
        banners.some((b) => b.bannerUrl?.includes(k)) ||
        photos.some((p) => p.photoUrl?.includes(k))
      ) {
        shown.add(k);
      }
    }
  }
  if (shown.size > 0) {
    out.eventKept = (
      await prisma.storageObject.updateMany({
        where: { wawuUserId: id, key: { in: [...shown] } },
        data: { wawuUserId: DELETED_CREATOR_ID },
      })
    ).count;
  }

  // DELETE: everything of the person's that is left, page by page.
  const deadline = Date.now() + FILE_BUDGET_MS;
  let after: string | null = null;
  for (;;) {
    const rows: Array<{ id: string; key: string }> =
      await prisma.storageObject.findMany({
        where: {
          wawuUserId: id,
          ...notSold,
          ...(after ? { id: { gt: after } } : {}),
        },
        orderBy: { id: 'asc' },
        take: PAGE,
        select: { id: true, key: true },
      });
    if (rows.length === 0) break;
    after = rows[rows.length - 1].id;

    if (!bucket) {
      const { count } = await prisma.storageObject.deleteMany({
        where: { id: { in: rows.map((r) => r.id) }, wawuUserId: id },
      });
      out.rowsDeleted += count;
      continue;
    }

    // A key that does not carry this person's id is not one of their uploads
    // (presign and putGenerated always put it there): the row goes, the object
    // is left alone.
    const own = rows.filter((r) => namesPerson(r.key, id));
    const foreign = rows.filter((r) => !namesPerson(r.key, id));
    if (foreign.length > 0) {
      logger.error(
        `${foreign.length} file row(s) of ${id} name a key outside their folder; the rows go, the objects are left alone`,
      );
    }
    const result = await bucket.removeMany(
      own.map((r) => r.key),
      deadline,
    );
    const gone = new Set(result.gone);
    out.objectsRemoved += gone.size;
    const done = [...own.filter((r) => gone.has(r.key)), ...foreign];
    if (done.length > 0) {
      const { count } = await prisma.storageObject.deleteMany({
        where: { id: { in: done.map((r) => r.id) }, wawuUserId: id },
      });
      out.rowsDeleted += count;
    }
    if (result.stopped) break;
  }
  if (bucket) {
    const rest = await prisma.storageObject.count({
      where: { wawuUserId: id, ...notSold },
    });
    if (rest > 0) out.left = `${rest} file(s) are still in the bucket`;
  }
  if (!bucket && out.rowsDeleted > 0) {
    logger.error(
      `The Hub has no object storage configured: ${out.rowsDeleted} file row(s) of ${id} were deleted without removing any object`,
    );
  }
  return out;
}

/**
 * What the `purged` row says was kept on purpose (null when nothing was). The
 * rows of the files named here are filed under the deleted account
 * (`StorageObject.wawuUserId = 'deleted-account'`) so the owner can list them
 * (FIX-65).
 */
export function purgeNoteOf(purged: {
  keptForBuyers: number;
  files: { ownerKept: number; eventKept: number };
}): string | null {
  const parts: string[] = [];
  if (purged.keptForBuyers > 0) {
    parts.push(
      `${purged.keptForBuyers} content piece(s) that buyers paid for were kept hidden and anonymised`,
    );
  }
  if (purged.files.ownerKept > 0) {
    parts.push(
      `${purged.files.ownerKept} identity or verification file(s) kept for the owner's ruling`,
    );
  }
  if (purged.files.eventKept > 0) {
    parts.push(
      `${purged.files.eventKept} event image(s) kept while an event of this person still stands`,
    );
  }
  return parts.length > 0 ? parts.join('; ') : null;
}
