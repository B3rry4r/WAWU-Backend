/**
 * Joins the mp3 pieces of an Audiobook into one file (AITOOLS-13, R-109). MPEG audio frames of one format join by
 * writing one after the other; what must not be copied is what only makes sense at the head of a file: an ID3 tag, a
 * Xing or Info header frame (which carries the length of its own piece), and a trailing ID3v1 tag. Every piece is
 * walked frame by frame, so a piece that is not whole MPEG audio, or is in another format than the first, is refused
 * (the job fails and every point goes back) instead of being joined into a file that skips or plays wrong. Pure.
 */

export class Mp3Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Mp3Error';
  }
}

export interface Mp3Body {
  /** The frames only, ready to be written after another piece's. */
  body: Buffer;
  frames: number;
  sampleRate: number;
  /** MPEG version (1, 2 or 2.5) and channel mode make the format two pieces must share. */
  version: 1 | 2 | 2.5;
  mono: boolean;
  seconds: number;
}

const BITRATES_V1 = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
];
const BITRATES_V2 = [
  0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160,
];
const RATES: Record<number, number[]> = {
  1: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  2.5: [11025, 12000, 8000],
};

interface FrameHead {
  size: number;
  samples: number;
  sampleRate: number;
  version: 1 | 2 | 2.5;
  mono: boolean;
}

function frameAt(buf: Buffer, i: number): FrameHead | null {
  if (i + 4 > buf.length) return null;
  if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) return null;
  const versionBits = (buf[i + 1] >> 3) & 3;
  const layerBits = (buf[i + 1] >> 1) & 3;
  if (versionBits === 1 || layerBits !== 1) return null; // reserved, or not Layer III
  const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5;
  const rateIndex = (buf[i + 2] >> 2) & 3;
  const bitrateIndex = buf[i + 2] >> 4;
  if (rateIndex === 3 || bitrateIndex === 0 || bitrateIndex === 15) return null;
  const sampleRate = RATES[version][rateIndex];
  const bitrate =
    (version === 1 ? BITRATES_V1 : BITRATES_V2)[bitrateIndex] * 1000;
  const padding = (buf[i + 2] >> 1) & 1;
  const samples = version === 1 ? 1152 : 576;
  const size =
    Math.floor(((version === 1 ? 144 : 72) * bitrate) / sampleRate) + padding;
  return { size, samples, sampleRate, version, mono: buf[i + 3] >> 6 === 3 };
}

/** The byte just past a leading ID3v2 tag, or 0 when there is none. */
function afterId3v2(buf: Buffer): number {
  if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') return 0;
  const size =
    ((buf[6] & 0x7f) << 21) |
    ((buf[7] & 0x7f) << 14) |
    ((buf[8] & 0x7f) << 7) |
    (buf[9] & 0x7f);
  const footer = (buf[5] & 0x10) !== 0 ? 10 : 0;
  return 10 + size + footer;
}

/** True when the frame is a Xing or Info header (the length of its own piece, not sound). */
function isInfoFrame(buf: Buffer, at: number, head: FrameHead): boolean {
  const sideInfo =
    head.version === 1 ? (head.mono ? 17 : 32) : head.mono ? 9 : 17;
  const tag = buf.toString('latin1', at + 4 + sideInfo, at + 8 + sideInfo);
  return tag === 'Xing' || tag === 'Info';
}

/** Walks one piece: its frames, without the tags and the header frame. Throws `Mp3Error` when it is not whole MPEG audio. */
export function readMp3(piece: Buffer): Mp3Body {
  let at = afterId3v2(piece);
  let end = piece.length;
  // A trailing ID3v1 tag is 128 bytes that begin with "TAG".
  if (
    end - 128 >= at &&
    piece.toString('latin1', end - 128, end - 125) === 'TAG'
  )
    end -= 128;
  let first: FrameHead | null = null;
  let bodyStart = -1;
  let frames = 0;
  let samples = 0;
  while (at < end) {
    const head = frameAt(piece, at);
    if (!head || at + head.size > end)
      throw new Mp3Error('not whole mpeg audio');
    if (first === null) {
      first = head;
    } else if (
      head.sampleRate !== first.sampleRate ||
      head.version !== first.version ||
      head.mono !== first.mono
    ) {
      throw new Mp3Error('the frames change format inside a piece');
    }
    if (!(frames === 0 && isInfoFrame(piece, at, head))) {
      if (bodyStart < 0) bodyStart = at;
      frames += 1;
      samples += head.samples;
    }
    at += head.size;
  }
  if (first === null || frames === 0 || bodyStart < 0)
    throw new Mp3Error('no audio in a piece');
  return {
    body: piece.subarray(bodyStart, end),
    frames,
    sampleRate: first.sampleRate,
    version: first.version,
    mono: first.mono,
    seconds: samples / first.sampleRate,
  };
}

/** True when two walked pieces can be written one after the other. */
export function sameFormat(a: Mp3Body, b: Mp3Body): boolean {
  return (
    a.sampleRate === b.sampleRate &&
    a.version === b.version &&
    a.mono === b.mono
  );
}

/** Joins whole pieces into one buffer (for specs and short files); the follower streams the same bodies one at a time. */
export function joinMp3(pieces: readonly Buffer[]): {
  audio: Buffer;
  seconds: number;
  frames: number;
} {
  if (pieces.length === 0) throw new Mp3Error('nothing to join');
  const read = pieces.map(readMp3);
  for (const r of read)
    if (!sameFormat(read[0], r))
      throw new Mp3Error('the pieces differ in format');
  return {
    audio: Buffer.concat(read.map((r) => r.body)),
    seconds: read.reduce((n, r) => n + r.seconds, 0),
    frames: read.reduce((n, r) => n + r.frames, 0),
  };
}
