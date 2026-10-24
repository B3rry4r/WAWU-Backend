import { parseBuffer } from 'music-metadata';

/**
 * How long a recording is, read from the file's own container (AITOOLS-04).
 * The library is `music-metadata` (pure JavaScript, no ffmpeg on the Hub): it
 * reads MP3, WAV, MP4 and M4A, AAC (ADTS), QuickTime and WebM. Pure and
 * synchronous in effect: it reads the bytes it is given and touches nothing
 * else. The phone's own idea of a length is never used.
 *
 * Returns the length in seconds, or null when the file's length cannot be
 * read (not a recording, damaged, or a container that holds no length).
 */
export async function readSeconds(
  bytes: Buffer,
  contentType: string,
): Promise<number | null> {
  const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The declared type is a hint; a file the hint does not fit is read again
  // from its own bytes (the container says what it is).
  for (const hint of [{ mimeType: contentType }, {}]) {
    try {
      const meta = await parseBuffer(view, hint, {
        duration: true,
        skipCovers: true,
      });
      const seconds = meta.format.duration;
      if (
        typeof seconds === 'number' &&
        Number.isFinite(seconds) &&
        seconds > 0
      )
        return seconds;
    } catch {
      // try the next reading
    }
  }
  return null;
}

/** Minutes a length is priced in: rounded up, at least 1. */
export function minutesOf(seconds: number): number {
  return Math.max(1, Math.ceil(seconds / 60));
}
