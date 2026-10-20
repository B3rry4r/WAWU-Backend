import {
  EXTENSION_FOR_CONTENT_TYPE,
  MAX_UPLOAD_BYTES,
  UPLOAD_FORMAT_IDS,
  type UploadFormatId,
} from './dto/presign-upload.dto';

export { UPLOAD_FORMAT_IDS, type UploadFormatId };

/**
 * What each content format may upload (ME-04: M20 picks a format, M21 uploads
 * the full file, M22 the separate public preview). One table, served by
 * GET /uploads/formats so the app draws its hints from it, and read by
 * StorageService.presignUpload when a caller names a `format`, so what the app
 * says is what the Hub accepts.
 *
 * Additive: a presign call that names no `format` is checked exactly as it was
 * (the folder's type list and the one global cap). Naming a format only adds
 * its rules on top.
 *
 * The types are the ones the Hub already stores and serves for the folder
 * (`FOLDER_CONTENT_TYPES`), plus audio and QuickTime in `content/preview`,
 * which a clip for an audio piece needs. Every type here has an extension in
 * `EXTENSION_FOR_CONTENT_TYPE`, so it is stored and served as that kind of
 * file and nothing else (a spec checks it, and that no type can run as a page).
 */

/** The two places a format's files go. */
export const FORMAT_FOLDERS = ['content/full', 'content/preview'] as const;
export type FormatFolder = (typeof FORMAT_FOLDERS)[number];

/** How a buyer is shown the part they get before paying. */
export type PreviewKind = 'clip' | 'lesson' | 'extract' | 'cover';

export interface UploadFormatRule {
  id: UploadFormatId;
  /** The full file: what is locked until someone buys. */
  full: { contentTypes: readonly string[]; maxBytes: number };
  /** The separate public preview file. `seconds` is the length asked of a clip. */
  preview: {
    kind: PreviewKind;
    contentTypes: readonly string[];
    maxBytes: number;
    seconds: { min: number; max: number } | null;
  };
}

const MB = 1024 * 1024;

const IMAGES = ['image/png', 'image/jpeg', 'image/webp'] as const;
const OFFICE = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/csv',
  'application/zip',
] as const;

/**
 * PROVISIONAL(ME-04-PDF-MAX-BYTES, owner=YOU, why=the M21 artboard draws "Up to
 * 100 MB" for a PDF and no ruling sizes it): 100 MB for a PDF, and its
 * extract.
 */
const PDF_MAX_BYTES = 100 * MB;

/**
 * PROVISIONAL(ME-04-AUDIO-CLIP-SECONDS, owner=YOU, why=the M20 artboard draws a
 * "30 to 60 second clip" for audio and no ruling sets it; the Hub cannot read
 * a file's length, so this is the length asked of the creator, not a check):
 * 30 to 60 seconds.
 */
const AUDIO_CLIP_SECONDS = { min: 30, max: 60 } as const;

/**
 * The other formats keep the Hub's one existing per-file cap
 * (`MAX_UPLOAD_BYTES`): no ruling sizes them, so none is invented.
 */
export const UPLOAD_FORMATS: readonly UploadFormatRule[] = [
  {
    id: 'video',
    full: {
      contentTypes: ['video/mp4', 'video/quicktime'],
      maxBytes: MAX_UPLOAD_BYTES,
    },
    preview: {
      kind: 'clip',
      contentTypes: ['video/mp4'],
      maxBytes: MAX_UPLOAD_BYTES,
      seconds: null,
    },
  },
  {
    id: 'course',
    full: {
      contentTypes: [
        'video/mp4',
        'video/quicktime',
        'application/pdf',
        'application/zip',
      ],
      maxBytes: MAX_UPLOAD_BYTES,
    },
    preview: {
      kind: 'lesson',
      contentTypes: ['video/mp4'],
      maxBytes: MAX_UPLOAD_BYTES,
      seconds: null,
    },
  },
  {
    id: 'audio',
    full: {
      contentTypes: ['audio/mpeg', 'audio/wav'],
      maxBytes: MAX_UPLOAD_BYTES,
    },
    preview: {
      kind: 'clip',
      contentTypes: ['audio/mpeg', 'audio/wav'],
      maxBytes: MAX_UPLOAD_BYTES,
      seconds: AUDIO_CLIP_SECONDS,
    },
  },
  {
    id: 'pdf',
    full: { contentTypes: ['application/pdf'], maxBytes: PDF_MAX_BYTES },
    preview: {
      kind: 'extract',
      contentTypes: ['application/pdf'],
      maxBytes: PDF_MAX_BYTES,
      seconds: null,
    },
  },
  {
    id: 'image',
    full: { contentTypes: IMAGES, maxBytes: MAX_UPLOAD_BYTES },
    preview: {
      kind: 'cover',
      contentTypes: IMAGES,
      maxBytes: MAX_UPLOAD_BYTES,
      seconds: null,
    },
  },
  {
    id: 'template',
    full: { contentTypes: OFFICE, maxBytes: MAX_UPLOAD_BYTES },
    preview: {
      kind: 'cover',
      contentTypes: [...IMAGES, 'application/pdf'],
      maxBytes: MAX_UPLOAD_BYTES,
      seconds: null,
    },
  },
];

export function formatRule(id: UploadFormatId): UploadFormatRule {
  const rule = UPLOAD_FORMATS.find((f) => f.id === id);
  if (!rule) throw new Error(`No upload rule for format ${id}`);
  return rule;
}

/** One format's rule for one folder: the types it takes and the most bytes. */
export function formatFolderRule(
  id: UploadFormatId,
  folder: FormatFolder,
): { contentTypes: readonly string[]; maxBytes: number } {
  const rule = formatRule(id);
  return folder === 'content/full' ? rule.full : rule.preview;
}

/** The extension a type is stored under, as the app shows it (`MP4`, `MOV`). */
function extensionsOf(types: readonly string[]): string[] {
  return types.map((t) => EXTENSION_FOR_CONTENT_TYPE[t] ?? '');
}

/** The response of GET /uploads/formats. */
export interface UploadFormatView {
  id: UploadFormatId;
  full: { contentTypes: string[]; extensions: string[]; maxBytes: number };
  preview: {
    kind: PreviewKind;
    contentTypes: string[];
    extensions: string[];
    maxBytes: number;
    seconds: { min: number; max: number } | null;
  };
}

export interface UploadFormatsView {
  formats: UploadFormatView[];
}

export function uploadFormatsView(): UploadFormatsView {
  return {
    formats: UPLOAD_FORMATS.map((f) => ({
      id: f.id,
      full: {
        contentTypes: [...f.full.contentTypes],
        extensions: extensionsOf(f.full.contentTypes),
        maxBytes: f.full.maxBytes,
      },
      preview: {
        kind: f.preview.kind,
        contentTypes: [...f.preview.contentTypes],
        extensions: extensionsOf(f.preview.contentTypes),
        maxBytes: f.preview.maxBytes,
        seconds: f.preview.seconds ? { ...f.preview.seconds } : null,
      },
    })),
  };
}
