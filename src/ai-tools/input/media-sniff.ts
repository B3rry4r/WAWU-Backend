/**
 * What a person's file really is, from its first bytes (AITOOLS-04 round 2).
 * A file is only ever parsed after it is one of the containers the AI tools
 * take; anything else is refused as unreadable before a parser sees it. The
 * declared type is never trusted and never used to pick a parser: the
 * container named here is the only hint the length reader gets, so a file
 * cannot steer the reader into a parser it was not sniffed for (an ID3 tag
 * in front of another container, for one, is read as MP3 or not at all).
 */
export type MediaContainer = 'wav' | 'mp3' | 'aac' | 'mp4' | 'webm';

/** The type the length reader is told to use for each container (QuickTime is read as ISO BMFF, like MP4). */
export const MIME_OF_CONTAINER: Record<MediaContainer, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  aac: 'audio/aac',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

const ascii = (b: Uint8Array, from: number, to: number): string =>
  String.fromCharCode(...b.subarray(from, to));

/** An ID3v2 tag header: version 2 to 4, a revision, and a size in four 7-bit bytes. */
function isId3v2(b: Uint8Array): boolean {
  return (
    ascii(b, 0, 3) === 'ID3' &&
    b[3] >= 2 &&
    b[3] <= 4 &&
    b[4] !== 0xff &&
    b[6] < 0x80 &&
    b[7] < 0x80 &&
    b[8] < 0x80 &&
    b[9] < 0x80
  );
}

/**
 * The container the file's first bytes name, or null when it is none of the
 * ones the tools take (WAV, MP3, ADTS AAC, MP4/M4A/MOV, WebM/Matroska).
 * Ogg is not taken: the Hub serves no Ogg type.
 */
export function sniffContainer(head: Uint8Array): MediaContainer | null {
  if (head.length < 12) return null;
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WAVE')
    return 'wav';
  // An ISO base media file (MP4, M4A, QuickTime) opens with an 'ftyp' box.
  if (ascii(head, 4, 8) === 'ftyp') return 'mp4';
  // The EBML header of WebM and Matroska.
  if (
    head[0] === 0x1a &&
    head[1] === 0x45 &&
    head[2] === 0xdf &&
    head[3] === 0xa3
  )
    return 'webm';
  if (isId3v2(head)) return 'mp3';
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) {
    // ADTS AAC: sync word, layer bits 00, a valid sampling-frequency index.
    if ((head[1] & 0xf6) === 0xf0) {
      return ((head[2] >> 2) & 0x0f) <= 12 ? 'aac' : null;
    }
    // An MPEG audio frame: a real version, a real layer, a real bitrate and sample rate.
    const version = (head[1] >> 3) & 3;
    const layer = (head[1] >> 1) & 3;
    const bitrate = head[2] >> 4;
    const rate = (head[2] >> 2) & 3;
    if (version !== 1 && layer !== 0 && bitrate !== 0x0f && rate !== 3)
      return 'mp3';
  }
  return null;
}
