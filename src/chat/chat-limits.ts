/**
 * PROVISIONAL(CHAT-LIMITS, owner=YOU, why=only the I13 artboard names 20 MB for a PDF; no ruling names a chat text length or a chat photo or video size)
 *
 * The limits on a free chat message (task INBOX-06, DECISIONS R-13; FIX-104).
 *
 * - A PDF may be up to 20 MB: the figure the "Add to chat" sheet (I13) shows
 *   under File. Nothing else in the system names it.
 * - A photo or a video may be up to 100 MB: the limit the Hub already puts on
 *   a picture or a video in a message or on a work (`profile/work` and
 *   `community/message-video` in FOLDER_MAX_BYTES), so no new figure is made
 *   up. Without it one message could be the 512 MB every upload is held to.
 * - Text is held to 2,000 characters, the length a community message already
 *   allows (CreateCommunityMessageDto), so the two kinds of chat agree.
 * - A link to read an attachment lives 15 minutes (900 seconds), the life of
 *   the Hub's other short-lived read links (StorageService.signedReadUrl).
 *   The route that makes one only answers a person in the chat.
 *
 * What a chat upload costs: its bytes count toward the sender's storage
 * (R-7, QUOTA_FOLDERS in src/storage/storage.service.ts), the same 1 GB for a
 * free account and 10 GB with a tick, and a file that does not fit is refused
 * with the same 413 `storage_limit_reached` as a creator's upload. It does not
 * count as one of the account's uploads (the 5 or 25 pieces): a chat message
 * is not a listing.
 *
 * Nothing scans a chat file for a virus. The type is checked against the
 * folder's list and the link serves it as that type, as an attachment for a
 * PDF; the bytes themselves are not looked into (BACKEND_GAPS G-FIX-104-1).
 */
export const CHAT_LIMITS = {
  fileMaxBytes: 20 * 1024 * 1024,
  mediaMaxBytes: 100 * 1024 * 1024,
  textMaxLength: 2000,
  linkSeconds: 900,
} as const;

/** Upload folders only a chat writes to. Not offered by POST /uploads/presign. */
export const CHAT_UPLOAD_FOLDERS = ['chat/media', 'chat/file'] as const;
export type ChatUploadFolder = (typeof CHAT_UPLOAD_FOLDERS)[number];

/** What each chat folder may hold: the I13 sheet's "Photo or video" and "File (PDF)". */
export const CHAT_FOLDER_CONTENT_TYPES: Record<
  ChatUploadFolder,
  readonly string[]
> = {
  'chat/media': [
    'image/png',
    'image/jpeg',
    'image/webp',
    'video/mp4',
    'video/quicktime',
  ],
  'chat/file': ['application/pdf'],
};
