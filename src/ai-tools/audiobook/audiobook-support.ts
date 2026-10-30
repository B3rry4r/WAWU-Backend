import { AI_AUDIOBOOK_PART_FOLDER, audioKeyFor } from '../audio/ai-audio-store';

/**
 * Small, pure helpers for the Audiobook (AITOOLS-13): how the Hub keeps its place while it speaks a long text one
 * chapter at a time. The place is the chapter files already stored (`partKeyFor`), so a Hub that restarts finds every
 * finished chapter and carries on with the next; nothing is spoken (or paid at the provider) twice. No I/O.
 */

/** What `providerRef` holds while the Hub speaks an audiobook: `bookrun:<chapters>:<characters a chapter>`. */
export const BOOK_PREFIX = 'bookrun:';

export interface BookRef {
  /** How many chapters the text made when the job began. */
  chapters: number;
  /** The chapter size it was cut at; the same size cuts the same chapters again after a restart, whatever the setting says now. */
  chunkChars: number;
}

export function bookRef(chapters: number, chunkChars: number): string {
  return `${BOOK_PREFIX}${chapters}:${chunkChars}`;
}

export function parseBookRef(marker: string | null): BookRef | null {
  if (!marker || !marker.startsWith(BOOK_PREFIX)) return null;
  const m = /^(\d{1,4}):(\d{3,5})$/.exec(marker.slice(BOOK_PREFIX.length));
  if (!m) return null;
  const chapters = Number(m[1]);
  const chunkChars = Number(m[2]);
  return chapters >= 1 && chunkChars >= 200 ? { chapters, chunkChars } : null;
}

/** The key chapter `index` (from 0) of a job is stored under: one file for each, found again without a column write. */
export function partKeyFor(
  wawuUserId: string,
  jobId: string,
  index: number,
): string {
  return audioKeyFor(
    wawuUserId,
    `${jobId}-c${index}`,
    AI_AUDIOBOOK_PART_FOLDER,
  );
}
