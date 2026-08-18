import { IsIn, IsInt, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

/**
 * Upload destinations the client may ask for. Closed set: a caller cannot
 * invent a folder and scatter objects across the bucket.
 */
export const UPLOAD_FOLDERS = [
  'content/preview',
  'content/full',
  'kyc/id-document',
  'service-application/document',
  'avatars',
] as const;

export type UploadFolder = (typeof UPLOAD_FOLDERS)[number];

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
  avatars: IMAGE,
};

export class PresignUploadDto {
  @IsIn(UPLOAD_FOLDERS)
  folder: UploadFolder;

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
