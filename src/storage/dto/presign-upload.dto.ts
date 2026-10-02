import {
  IsIn,
  IsInt,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  CHAT_FOLDER_CONTENT_TYPES,
  type ChatUploadFolder,
} from '../../chat/chat-limits';

/**
 * Upload destinations the client may ask for. Closed set: a caller cannot
 * invent a folder and scatter objects across the bucket.
 */
export const UPLOAD_FOLDERS = [
  'content/preview',
  'content/full',
  'kyc/id-document',
  'service-application/document',
  // A practising licence or qualification supporting a professional-profile
  // application. Its own prefix rather than reusing service-application: a
  // different reviewer opens it, under a different role, and mixing the two
  // would widen who can read a practising certificate.
  'professional/document',
  // Whatever a client attaches to a legal intake — a contract, a demand
  // letter, a court document. Its own prefix: only the consultant working
  // that matter should ever be able to read it, and sharing a prefix with
  // another surface widens who can.
  'legal/document',
  'avatars',
  // The wide image behind a profile header and on that creator's cards. Its
  // own prefix rather than reusing avatars: different shape, different place
  // on screen, and a creator replacing one must not disturb the other.
  'profile/cover',
  // A community's own cover image, and a photo posted into a room. Two
  // destinations, not one: the cover is written by the host alone, a message
  // photo by any member, so they never share a prefix.
  'community/image',
  'community/message',
  // A speaker's photo on a submitted event. Its own prefix: set by the host
  // (never the speaker themselves, who may have no WAWU account at all) and
  // shown publicly once the event is approved, same visibility as the
  // banner image.
  'event/speaker',
] as const;

/** The folders a client may name on POST /uploads/presign. */
export type PublicUploadFolder = (typeof UPLOAD_FOLDERS)[number];

/**
 * Every folder the presigner writes to: the public ones, plus the chat
 * folders (task INBOX-06). Chat uploads go through POST /chats/:chatId/
 * attachments, which checks the chat and any block first, so the chat
 * folders are deliberately not in UPLOAD_FOLDERS and the public route still
 * refuses them.
 */
export type UploadFolder = PublicUploadFolder | ChatUploadFolder;

/** 512MB — the largest asset the product allows (video). */
export const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

/**
 * What each destination may actually hold.
 *
 * Validating only that `contentType` *looks* like a MIME type let any signed-in
 * user store `text/html` (or `image/svg+xml`) and get back a presigned URL that
 * serves it executable from the storage origin — stored XSS, reachable by
 * planting it as a content preview. Anything not on this list is rejected.
 */
const IMAGE = ['image/png', 'image/jpeg', 'image/webp'];
const DOC = ['application/pdf'];
const AV = [
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'audio/mpeg',
  'audio/wav',
  'audio/mp4',
  'audio/aac',
];
const OFFICE = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/csv',
  'application/zip',
];

export const FOLDER_CONTENT_TYPES: Record<UploadFolder, readonly string[]> = {
  'content/preview': [...IMAGE, ...DOC, 'video/mp4'],
  'content/full': [...IMAGE, ...DOC, ...AV, ...OFFICE],
  'kyc/id-document': [...IMAGE, ...DOC],
  'service-application/document': [...IMAGE, ...DOC],
  'professional/document': [...IMAGE, ...DOC],
  'legal/document': [...IMAGE, ...DOC],
  avatars: IMAGE,
  'profile/cover': IMAGE,
  // Images only, deliberately. A community image is rendered in place by
  // every client (serveAs() returns inline: true for image/*), which is
  // exactly the case the allowlist above exists to keep documents and
  // markup out of.
  'community/image': IMAGE,
  'community/message': IMAGE,
  'event/speaker': IMAGE,
  ...CHAT_FOLDER_CONTENT_TYPES,
};

/**
 * The one extension each allowed type is stored under, and the type each
 * extension is served back as.
 *
 * This exists because the allowlist above was ADVISORY ONLY. The presigner
 * drops `ContentType` entirely — it is neither signed into the URL nor hoisted
 * to a query parameter — so nothing stopped a caller from presigning as
 * `image/jpeg`, passing the allowlist, and then PUTting `text/html` bytes with
 * whatever Content-Type they liked. The object came back on a week-long read
 * URL serving exactly what the allowlist was written to prevent.
 *
 * So the server picks the extension from the type it VALIDATED, and read URLs
 * force the matching Content-Type back on the way out. The bytes are then
 * served as the declared kind of file whatever the uploader actually sent.
 */
export const EXTENSION_FOR_CONTENT_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation':
    'pptx',
  'text/csv': 'csv',
  'application/zip': 'zip',
};

const CONTENT_TYPE_FOR_EXTENSION: Record<string, string> = Object.fromEntries(
  Object.entries(EXTENSION_FOR_CONTENT_TYPE).map(([type, ext]) => [ext, type]),
);

/**
 * What to serve a stored object as. An extension this server never issued
 * (an object from before this rule, or anything unrecognised) is served as an
 * opaque download rather than being guessed at.
 */
export function serveAs(key: string): { contentType: string; inline: boolean } {
  const ext = key.split('.').pop()?.toLowerCase() ?? '';
  const contentType = CONTENT_TYPE_FOR_EXTENSION[ext];
  if (!contentType)
    return { contentType: 'application/octet-stream', inline: false };
  // Images, video and audio render in place — a cover, a preview thumbnail, an
  // avatar, or a content piece's own player. `Content-Disposition: attachment`
  // on a video/audio object makes a browser refuse to stream it into a
  // `<video>`/`<audio>` element at all (it offers a download instead of
  // playing), which is exactly the "preview never plays" failure this fixes:
  // the Content-Type was already correct, the disposition was not.
  // Everything else is a file you receive, including every PDF: an inline PDF
  // is a document viewer pointed at user-supplied bytes.
  const inline =
    contentType.startsWith('image/') ||
    contentType.startsWith('video/') ||
    contentType.startsWith('audio/');
  return { contentType, inline };
}

export class PresignUploadDto {
  @IsIn(UPLOAD_FOLDERS)
  folder: PublicUploadFolder;

  /** e.g. "image/jpeg", "video/mp4", "application/pdf". */
  @IsString()
  @MaxLength(120)
  @Matches(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i, {
    message: 'contentType must be a valid MIME type',
  })
  contentType: string;

  /** File extension without the dot. Sanitised again server-side. */
  @IsString()
  @MaxLength(8)
  extension: string;

  /**
   * Exact byte length of the file. The presigned URL is signed FOR this
   * length, so storage rejects an upload of any other size — previously the
   * only cap was client-side and trivially bypassed by calling the presigned
   * URL directly.
   */
  @IsInt()
  @Min(1)
  @Max(MAX_UPLOAD_BYTES)
  contentLength: number;
}
