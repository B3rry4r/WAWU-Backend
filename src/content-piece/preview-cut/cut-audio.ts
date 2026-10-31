import {
  CutRefusal,
  MIN_SOURCE_SECONDS,
  previewSecondsFor,
  type CutResult,
  type CutSource,
} from './cut-types';

const MIB = 1024 * 1024;
/** The most of a file read to find its first frames (30 seconds of the largest MP3 is 1.2 MB). */
const MP3_WINDOW = 6 * MIB;
/** The most of a WAV's samples a preview may take (30 seconds of 24 bit 96 kHz stereo is 17 MB). */
const WAV_MAX_BYTES = 48 * MIB;

const MPEG1_L3 = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
];
const MPEG2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000],
};

interface Frame {
  length: number;
  samples: number;
  rate: number;
  bitrate: number;
}

/** The MPEG audio frame whose header starts at `p`, or null when there is not one (Layer III only). */
function frameAt(b: Buffer, p: number): Frame | null {
  if (p + 4 > b.length || b[p] !== 0xff || (b[p + 1] & 0xe0) !== 0xe0)
    return null;
  const version = (b[p + 1] >> 3) & 3;
  const layer = (b[p + 1] >> 1) & 3;
  if (version === 1 || layer !== 1) return null;
  const bitrateIndex = (b[p + 2] >> 4) & 15;
  const rateIndex = (b[p + 2] >> 2) & 3;
  if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const bitrate = (version === 3 ? MPEG1_L3 : MPEG2_L3)[bitrateIndex];
  const rate = RATES[version][rateIndex];
  const padding = (b[p + 2] >> 1) & 1;
  const samples = version === 3 ? 1152 : 576;
  const length = Math.floor(((samples / 8) * bitrate * 1000) / rate) + padding;
  return { length, samples, rate, bitrate };
}

/** Where the sound starts: past an ID3v2 tag when the file begins with one. */
function audioStartOf(head: Buffer): number {
  if (head.length >= 10 && head.toString('latin1', 0, 3) === 'ID3') {
    const size =
      ((head[6] & 0x7f) << 21) |
      ((head[7] & 0x7f) << 14) |
      ((head[8] & 0x7f) << 7) |
      (head[9] & 0x7f);
    return 10 + size + ((head[5] & 0x10) !== 0 ? 10 : 0);
  }
  return 0;
}

/**
 * The first seconds of an MP3, cut on a frame edge (no re-encoding): the
 * whole frames from the first one until the preview's length is reached. The
 * tag and the length header are left out, so the cut is bare sound that every
 * player reads. A file's length is read from its length header when it has
 * one, else worked out from its bitrate (the same as a player does).
 */
export async function cutMp3(source: CutSource): Promise<CutResult> {
  const first = await source.read(0, Math.min(source.length, 16));
  const start = audioStartOf(first);
  if (start >= source.length) throw new CutRefusal('unsupported');
  const buf = await source.read(
    start,
    Math.min(source.length, start + MP3_WINDOW),
  );
  // The first frame: allow a little padding before it.
  let p = 0;
  let f: Frame | null = null;
  for (; p < Math.min(buf.length, 65536); p += 1) {
    f = frameAt(buf, p);
    if (f && frameAt(buf, p + f.length)) break;
    f = null;
  }
  if (!f) throw new CutRefusal('unsupported');
  const firstAt = p;
  // A length header ("Xing" or "Info") is a frame of its own that holds no sound.
  let xingFrames: number | null = null;
  const probe = buf.toString('latin1', p + 4, Math.min(buf.length, p + 48));
  const tag = /Xing|Info/.exec(probe);
  if (tag) {
    const at = p + 4 + tag.index + 4;
    const flags = buf.readUInt32BE(at);
    if (flags & 1) xingFrames = buf.readUInt32BE(at + 4);
    p += f.length;
  }
  const info = frameAt(buf, p);
  if (!info) throw new CutRefusal('unsupported');
  const sourceSeconds =
    xingFrames !== null && xingFrames > 0
      ? (xingFrames * info.samples) / info.rate
      : ((source.length - start - firstAt) * 8) / (info.bitrate * 1000);
  if (!(sourceSeconds >= MIN_SOURCE_SECONDS)) throw new CutRefusal('too_short');
  const want = previewSecondsFor(sourceSeconds);
  const frames: Buffer[] = [];
  let seconds = 0;
  let lost = 0;
  while (p < buf.length && seconds < want) {
    const fr = frameAt(buf, p);
    if (!fr || p + fr.length > buf.length) {
      // Out of step (junk between frames) or the end of what was read: look for the next frame.
      lost += 1;
      if (lost > 4096) break;
      p += 1;
      continue;
    }
    lost = 0;
    frames.push(buf.subarray(p, p + fr.length));
    seconds += fr.samples / fr.rate;
    p += fr.length;
  }
  // Short of the length asked for with the file still going: the window was not enough (an odd file).
  if (frames.length === 0 || (seconds < want - 1 && p < source.length - start))
    throw new CutRefusal('unsupported');
  return {
    body: Buffer.concat(frames),
    contentType: 'audio/mpeg',
    seconds,
    sourceSeconds,
  };
}

/**
 * The first seconds of a WAV: its own format chunk, then that many whole
 * samples, under a fresh header. Any sample format the file uses is kept as
 * it is (the cut copies bytes).
 */
export async function cutWav(source: CutSource): Promise<CutResult> {
  const head = await source.read(0, Math.min(source.length, 65536));
  if (
    head.length < 44 ||
    head.toString('latin1', 0, 4) !== 'RIFF' ||
    head.toString('latin1', 8, 12) !== 'WAVE'
  )
    throw new CutRefusal('unsupported');
  let fmt: Buffer | null = null;
  let byteRate = 0;
  let blockAlign = 0;
  let dataAt = -1;
  let dataSize = 0;
  let p = 12;
  while (p + 8 <= head.length) {
    const id = head.toString('latin1', p, p + 4);
    const size = head.readUInt32LE(p + 4);
    if (id === 'fmt ' && p + 8 + size <= head.length && size >= 16) {
      fmt = head.subarray(p + 8, p + 8 + size);
      byteRate = fmt.readUInt32LE(8);
      blockAlign = fmt.readUInt16LE(12);
    } else if (id === 'data') {
      dataAt = p + 8;
      dataSize = size;
      break;
    }
    p += 8 + size + (size % 2);
  }
  if (!fmt || dataAt < 0 || byteRate <= 0 || blockAlign <= 0)
    throw new CutRefusal('unsupported');
  // A streamed file says 0 or 0xFFFFFFFF for the data's size: it runs to the end.
  const room = source.length - dataAt;
  if (dataSize === 0 || dataSize === 0xffffffff || dataSize > room)
    dataSize = room;
  const sourceSeconds = dataSize / byteRate;
  if (!(sourceSeconds >= MIN_SOURCE_SECONDS)) throw new CutRefusal('too_short');
  const want = previewSecondsFor(sourceSeconds);
  const bytes = Math.floor((want * byteRate) / blockAlign) * blockAlign;
  if (bytes <= 0) throw new CutRefusal('too_short');
  if (bytes > WAV_MAX_BYTES) throw new CutRefusal('too_big');
  const data = await source.read(dataAt, dataAt + bytes);
  if (data.length < bytes) throw new CutRefusal('unsupported');
  const out = Buffer.alloc(12 + 8 + fmt.length + (fmt.length % 2) + 8);
  out.write('RIFF', 0, 'latin1');
  out.write('WAVE', 8, 'latin1');
  out.write('fmt ', 12, 'latin1');
  out.writeUInt32LE(fmt.length, 16);
  fmt.copy(out, 20);
  const dataHead = 20 + fmt.length + (fmt.length % 2);
  out.write('data', dataHead, 'latin1');
  out.writeUInt32LE(bytes, dataHead + 4);
  out.writeUInt32LE(out.length - 8 + bytes, 4);
  return {
    body: Buffer.concat([out, data]),
    contentType: 'audio/wav',
    seconds: bytes / byteRate,
    sourceSeconds,
  };
}
