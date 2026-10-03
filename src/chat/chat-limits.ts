/**
 * PROVISIONAL(CHAT-LIMITS, owner=YOU, why=only the I13 artboard names 20 MB for a PDF; no ruling names a chat text length)
 *
 * The limits on a free chat message (task INBOX-06, DECISIONS R-13).
 *
 * - A PDF may be up to 20 MB: the figure the "Add to chat" sheet (I13) shows
 *   under File. Nothing else in the system names it.
 * - A photo or video is held to the per-file limit every upload already has
 *   (MAX_UPLOAD_BYTES in src/storage/dto/presign-upload.dto.ts), so no new
 *   figure is made up for it.
 * - Text is held to 2,000 characters, the length a community message already
 *   allows (CreateCommunityMessageDto), so the two kinds of chat agree.
 *
 * Chat uploads are outside the storage allowance (R-7 limits creator content
 * only, see CONTENT_FOLDERS in src/storage/storage.service.ts): they are not
 * counted against it and not refused by it.
 */
export const CHAT_LIMITS = {
  fileMaxBytes: 20 * 1024 * 1024,
  textMaxLength: 2000,
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
