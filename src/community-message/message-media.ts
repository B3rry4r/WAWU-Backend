import {
  deliverableKeyFrom,
  objectKeyFrom,
  type BucketLocation,
  type StorageService,
} from '../storage/storage.service';

/**
 * FIX-71 (G-INBOX-22-2). The photo, the video and the voice note of a
 * community message are stored as the link the app sent: the 7-day signed read
 * link of `POST /uploads/presign`. A week later the signature is dead although
 * the file is untouched in the bucket. Every path that returns a message
 * (list, send, live, catch-up, "my communities") signs the link again on the
 * way out, from the object key the stored link names, the way avatars and
 * content previews already are. Nothing stored is rewritten and no route
 * changes shape: each field still holds a link the app can load.
 */

/** The one folder each field's file may come from (the folders presign offers for a message). */
export const MESSAGE_MEDIA_FOLDERS = {
  imageUrl: 'community/message',
  videoUrl: 'community/message-video',
  voiceUrl: 'community/message-voice',
} as const;

export type MessageMediaField = keyof typeof MESSAGE_MEDIA_FOLDERS;

const MEDIA_FIELDS = Object.keys(MESSAGE_MEDIA_FOLDERS) as MessageMediaField[];

/** What re-signing needs of a message row: who sent it, and its three links. */
export interface MessageMediaRow {
  senderWawuId: string;
  imageUrl: string | null;
  videoUrl: string | null;
  voiceUrl: string | null;
}

/**
 * The object key to sign for one field of a message, or null when it must not
 * be signed. A key is signed only when it is exactly
 * `<that field's folder>/<the message's sender>/<one file name>`: the sender's
 * own upload, in the folder for that kind. The stored value is free text from
 * the sender (a photo link is not checked when it is sent), so a link that
 * names somebody else's file, a file from another folder (an identity document,
 * an avatar, a chat attachment) or a link to anywhere else is never turned into
 * a signed link for the room. It is returned as it was stored.
 */
export function ownMediaKey(
  stored: string,
  field: MessageMediaField,
  senderWawuId: string,
  location?: BucketLocation | null,
): string | null {
  const key = objectKeyFrom(stored);
  // FIX-71 L1: a link is the sender's own only when it is a link on THIS
  // bucket (its origin and path prefix, a key spelled out, no `%` escape).
  // `objectKeyFrom` finds the folder anywhere in the path and ignores the
  // host, so a link on another host that spells the right folder would
  // otherwise be signed and replace what was stored. A bare key has no host
  // to check. Without a `location` (the pure shape check) the host is not
  // looked at.
  if (location !== undefined && key !== stored) {
    if (
      deliverableKeyFrom(stored, location, [MESSAGE_MEDIA_FOLDERS[field]]) !==
      key
    ) {
      return null;
    }
  }
  const prefix = `${MESSAGE_MEDIA_FOLDERS[field]}/${senderWawuId}/`;
  if (!key.startsWith(prefix)) return null;
  const file = key.slice(prefix.length);
  // One file name, the shape presign writes: no further folder, no dots-only name.
  if (!/^[A-Za-z0-9._~-]+$/.test(file) || /^\.+$/.test(file)) return null;
  return key;
}

/**
 * The row with each of its links signed fresh for this response. A field that
 * is empty, or whose key is not the sender's own in the right folder, is left
 * exactly as stored. Storage that cannot sign right now (or is not configured)
 * leaves the stored link, as every other re-signing does.
 */
export async function withFreshMedia<T extends MessageMediaRow>(
  storage: Pick<StorageService, 'freshUrlFor' | 'bucketLocation'>,
  row: T,
): Promise<T> {
  const fresh: Partial<Record<MessageMediaField, string | null>> = {};
  let location: BucketLocation | null | undefined;
  for (const field of MEDIA_FIELDS) {
    const stored = row[field];
    if (!stored) continue;
    // Asked once, and only for a row that has a link to look at.
    location ??= await storage.bucketLocation();
    if (ownMediaKey(stored, field, row.senderWawuId, location) === null)
      continue;
    fresh[field] = await storage.freshUrlFor(stored);
  }
  return Object.keys(fresh).length === 0 ? row : { ...row, ...fresh };
}
