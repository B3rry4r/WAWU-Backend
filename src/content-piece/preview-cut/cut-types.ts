/**
 * PREVIEW-AUTO: the Hub makes a paid audio or video piece's public preview from
 * the creator's full file. These are the pieces every cutter shares. No ffmpeg
 * and no new package: the Hub reads media in plain JavaScript (AITOOLS-04,
 * `music-metadata`), and these cutters only copy bytes, so they run on the
 * Hub as it is deployed.
 */

/** How much of a file the preview takes, in seconds. */
export const PREVIEW_SECONDS = 30;
/** A file shorter than this gets its first third instead of the first 30 seconds. */
export const SHORT_FILE_SECONDS = 45;
/** A file shorter than this is too short to make a preview from (its third would be under one second). */
export const MIN_SOURCE_SECONDS = 3;

/** How long the preview of a file `sourceSeconds` long is meant to be. */
export function previewSecondsFor(sourceSeconds: number): number {
  return sourceSeconds < SHORT_FILE_SECONDS
    ? sourceSeconds / 3
    : PREVIEW_SECONDS;
}

/** A stored file the cutters read in parts, so a long file is never held whole. */
export interface CutSource {
  /** The file's length in bytes. */
  length: number;
  /** Bytes `start` to `endExclusive`; fewer come back at the end of the file. */
  read(start: number, endExclusive: number): Promise<Buffer>;
}

export interface CutResult {
  body: Buffer;
  contentType: string;
  /** The length of the preview, in seconds. */
  seconds: number;
  /** The length of the whole file, in seconds (read from the file, or estimated for an MP3 with no length header). */
  sourceSeconds: number;
}

export type CutRefusalCode = 'too_short' | 'unsupported' | 'too_big';

/** The words the creator is shown when the Hub cannot cut a preview (the creator can always use their own clip). */
export const CUT_WORDS: Record<CutRefusalCode, string> = {
  too_short:
    'This file is too short to make a preview from. Use your own clip.',
  unsupported: 'We could not make a preview from this file. Use your own clip.',
  too_big: 'This file is too large to make a preview from. Use your own clip.',
};

/** A file the cutters cannot make a preview from; `message` is the Hub's own words. */
export class CutRefusal extends Error {
  constructor(readonly code: CutRefusalCode) {
    super(CUT_WORDS[code]);
  }
}
