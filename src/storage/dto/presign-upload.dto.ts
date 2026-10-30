import {
  IsIn,
  IsInt,
  IsOptional,
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
  // INBOX-22 (R-62). A video and a voice note posted into a room. Their own
  // prefixes, not `community/message`: that folder holds photos only, and a
  // message's video or voice note must come from the folder that says so, so
  // the send can tell a video from a photo by where the file was uploaded.
  'community/message-video',
  'community/message-voice',
  // A speaker's photo on a submitted event. Its own prefix: set by the host
  // (never the speaker themselves, who may have no WAWU account at all) and
  // shown publicly once the event is approved, same visibility as the
  // banner image.
  'event/speaker',
  // An event's banner image (E14, EVENTS-04). Its own prefix: set by the
  // host on the event they submit, shown publicly once it is approved. The
  // speaker photos above share that visibility but not the place on screen.
  'event/banner',
  // A picture or a video on a featured work (ME-16), shown publicly on the
  // owner's profile. Its own prefix: only the owner may attach a key under
  // their own id, and the work routes check exactly that.
  'profile/work',
  // VOICE-01. The 30 second recording a person makes so the Hub can read their
  // Voice Intro in their own voice. Their own prefix: the file is a person's
  // voice, read only by the Hub for that person's own runs (never served to
  // anyone), and is removed when they replace it or delete the account.
  'voice/sample',
  // AITOOLS-04 (R-78). A recording or a video a person sends to an AI tool
  // (Captions, Clean audio, later Dubbing). Their own prefixes: the file is a
  // person's own words or voice, read only by the Hub for that person's own
  // run (never served to anyone else), counted in no allowance, and removed
  // when the job ends and when the account is deleted. Audio and video are
  // two folders so the Hub knows what it was given before it opens the file.
  'ai/input-audio',
  'ai/input-video',
  // AITOOLS-08 (R-109). A photo a person sends to Edit a photo, Make a video
  // (as the first frame) or Talking photo. Its own prefix, like the folders
  // above: the picture is the person's own, read only by the Hub for that
  // person's own run (never served to anyone else), counted in no allowance,
  // and removed when the job ends and when the account is deleted. Its own
  // name, not AI_INPUT_FOLDERS, which pins the two audio and video folders.
  'ai/input-image',
] as const;

/**
 * The content formats a presign call may name (ME-04). Defined here, not in
 * upload-formats.ts, which imports this file: the rules table reads
 * MAX_UPLOAD_BYTES when it loads.
 */
export const UPLOAD_FORMAT_IDS = [
  'video',
  'course',
  'audio',
  'pdf',
  'image',
  'template',
] as const;
export type UploadFormatId = (typeof UPLOAD_FORMAT_IDS)[number];

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

/** 500 MB: the most a file for an AI tool may be (AITOOLS-04), the provider's smallest documented limit. The setting `ai.input_max_bytes` starts here. */
export const AI_INPUT_MAX_BYTES = 500 * 1024 * 1024;
/** The admin setting (R-65) that caps a file for an AI tool, in bytes; it starts at `AI_INPUT_MAX_BYTES` and may only go lower. */
export const AI_INPUT_MAX_BYTES_SETTING = 'ai.input_max_bytes';
/** AITOOLS-08: the folder a person's photo for a Studio tool goes in, and the most one may be (25 MB, the provider's inline limit). */
export const AI_INPUT_IMAGE_FOLDER = 'ai/input-image';
export const AI_INPUT_IMAGE_MAX_BYTES = 25 * 1024 * 1024;
/** The two folders a person's file for an AI tool goes in. */
export const AI_INPUT_FOLDERS = ['ai/input-audio', 'ai/input-video'] as const;

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
  // INBOX-22. Video and voice, played in place by the room, so the same kind
  // of allowlist as the other folders that render inline. A voice note is what
  // a phone records (mp4 audio or aac) or an upload of the usual audio types.
  'community/message-video': ['video/mp4', 'video/quicktime', 'video/webm'],
  'community/message-voice': [
    'audio/mp4',
    'audio/aac',
    'audio/mpeg',
    'audio/wav',
  ],
  'event/speaker': IMAGE,
  'event/banner': IMAGE,
  // Photos, and a video for a showreel. No document types: this is drawn in
  // place on a public profile.
  'profile/work': [...IMAGE, 'video/mp4'],
  // VOICE-01. What a phone records, or the usual audio files.
  'voice/sample': ['audio/mp4', 'audio/aac', 'audio/mpeg', 'audio/wav'],
  // AITOOLS-04. The audio and video types the Hub already serves (AV above,
  // split by kind). Other types the provider accepts (FLAC, OGG, OPUS) are not
  // offered until the Hub serves them.
  'ai/input-audio': ['audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/aac'],
  'ai/input-video': ['video/mp4', 'video/quicktime', 'video/webm'],
  // AITOOLS-08. The three picture types the provider takes and the Hub serves.
  'ai/input-image': IMAGE,
  ...CHAT_FOLDER_CONTENT_TYPES,
};

/**
 * A per-file ceiling for a folder that the R-7 storage allowance does not
 * count, so one file cannot be as large as the 512MB the DTO allows.
 * PROVISIONAL(WORK-MEDIA-MAX-BYTES, owner=YOU, why=the allowance counts only
 * content/preview and content/full and no ruling sizes a featured work's
 * media): 100MB.
 */
export const FOLDER_MAX_BYTES: Partial<Record<UploadFolder, number>> = {
  'profile/work': 100 * 1024 * 1024,
  // PROVISIONAL(COMMUNITY-MEDIA-MAX-BYTES, owner=YOU, why=R-62 prices a video and a voice note in a community but no ruling sizes the file; the allowance counts only content/preview and content/full, so without a cap one message could be 512MB): 100MB for a video, 25MB for a voice note.
  'community/message-video': 100 * 1024 * 1024,
  'community/message-voice': 25 * 1024 * 1024,
  // PROVISIONAL(VOICE-SAMPLE-MAX-BYTES, owner=YOU, why=no ruling sizes the 30 second Voice Intro sample; the allowance does not count this folder): 10MB, more than 30 seconds of uncompressed phone audio.
  'voice/sample': 10 * 1024 * 1024,
  // 500MB: the provider's smallest documented limit for a file (docs/elevenlabs/API-FACTS.md). The live cap is the setting `ai.input_max_bytes` (provisional AITOOLS-LIMITS in plan-settings.defaults.json), which an admin may only lower; this is its ceiling.
  'ai/input-audio': AI_INPUT_MAX_BYTES,
  'ai/input-video': AI_INPUT_MAX_BYTES,
  'ai/input-image': AI_INPUT_IMAGE_MAX_BYTES,
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
  // AITOOLS-05: the lossless audio Dubbing makes. Only the Hub writes it (putGenerated);
  // no upload folder takes it.
  'audio/flac': 'flac',
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

  /**
   * Optional, ME-04: the content format the file is for (`video`, `pdf`...).
   * Only for `content/full` and `content/preview`. Naming one adds that
   * format's rules (GET /uploads/formats) to the checks below: the types it
   * takes in that folder and its own size cap. Left out, the call is checked
   * exactly as before.
   */
  @IsOptional()
  @IsIn(UPLOAD_FORMAT_IDS)
  format?: UploadFormatId;
}
