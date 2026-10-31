import { box } from '../../../test/ai-tools/media-fixtures';

/**
 * PREVIEW-AUTO: small media files built in memory for the cutters' specs (no file on disk, no ffmpeg: CI has none). The MP4 has a
 * video track (10 frames a second, a sync frame every 10, a `ctts`) and an audio track, interleaved in chunks, with the index at the
 * end of the file (as a phone writes it) or at the front.
 */
const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
};
const u16 = (n: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n, 0);
  return b;
};

export const VIDEO_SAMPLE = 120;
export const AUDIO_SAMPLE = 40;

export function videoSamplesFor(seconds: number): number {
  return Math.round(seconds * 10);
}
export function audioSamplesFor(seconds: number): number {
  return 8 * Math.ceil((seconds * 44100) / 1024 / 8);
}

export function syntheticMp4(
  seconds: number,
  opts: { moovFirst?: boolean; brand?: string } = {},
): Buffer {
  const nv = videoSamplesFor(seconds);
  const na = audioSamplesFor(seconds);
  const brand = (opts.brand ?? 'isom').padEnd(4).slice(0, 4);
  const ftyp = box('ftyp', Buffer.from(brand), u32(0), Buffer.from(brand));
  // mdat: chunk by chunk, ten video samples then eight audio samples.
  const chunks: { track: 1 | 2; size: number; samples: number }[] = [];
  for (let v = 0, a = 0; v < nv || a < na; v += 10, a += 8) {
    if (v < nv) chunks.push({ track: 1, size: 10 * VIDEO_SAMPLE, samples: 10 });
    if (a < na) chunks.push({ track: 2, size: 8 * AUDIO_SAMPLE, samples: 8 });
  }
  const payload = Buffer.concat(
    chunks.map((c, i) =>
      Buffer.alloc(c.size, (c.track * 64 + (i % 60)) & 0xff),
    ),
  );
  const mdat = box('mdat', payload);
  const moovFor = (mdatPayloadAt: number): Buffer => {
    const offsets: Record<number, number[]> = { 1: [], 2: [] };
    let at = mdatPayloadAt;
    for (const c of chunks) {
      offsets[c.track].push(at);
      at += c.size;
    }
    const tkhd = (id: number, ms: number) =>
      box(
        'tkhd',
        Buffer.from([0, 0, 0, 7]),
        u32(0),
        u32(0),
        u32(id),
        u32(0),
        u32(ms),
        Buffer.alloc(60),
      );
    const mdhd = (ts: number, dur: number) =>
      box(
        'mdhd',
        Buffer.alloc(4),
        u32(0),
        u32(0),
        u32(ts),
        u32(dur),
        u16(0x55c4),
        u16(0),
      );
    const hdlr = (kind: string) =>
      box(
        'hdlr',
        Buffer.alloc(4),
        Buffer.alloc(4),
        Buffer.from(kind),
        Buffer.alloc(12),
        Buffer.from('h\0'),
      );
    const dinf = box(
      'dinf',
      box(
        'dref',
        Buffer.alloc(4),
        u32(1),
        box('url ', Buffer.from([0, 0, 0, 1])),
      ),
    );
    const table = (type: string, ...rows: Buffer[]) =>
      box(type, Buffer.alloc(4), u32(rows.length), ...rows);
    const sync: Buffer[] = [];
    for (let i = 1; i <= nv; i += 10) sync.push(u32(i));
    const audioDesc = Buffer.concat([
      u16(0),
      u16(0),
      u32(0),
      u16(2),
      u16(16),
      u16(0),
      u16(0),
      u32(44100 * 65536),
    ]);
    const stblV = box(
      'stbl',
      box('stsd', Buffer.alloc(4), u32(1), box('avc1', Buffer.alloc(78))),
      table('stts', Buffer.concat([u32(nv), u32(100)])),
      table(
        'ctts',
        Buffer.concat([u32(1), u32(200)]),
        Buffer.concat([u32(nv - 1), u32(100)]),
      ),
      table('stss', ...sync),
      table('stsc', Buffer.concat([u32(1), u32(10), u32(1)])),
      box('stsz', Buffer.alloc(4), u32(VIDEO_SAMPLE), u32(nv)),
      table('stco', ...offsets[1].map(u32)),
    );
    const stblA = box(
      'stbl',
      box(
        'stsd',
        Buffer.alloc(4),
        u32(1),
        box('mp4a', Buffer.alloc(6), u16(1), audioDesc),
      ),
      table('stts', Buffer.concat([u32(na), u32(1024)])),
      table('stsc', Buffer.concat([u32(1), u32(8), u32(1)])),
      box(
        'stsz',
        Buffer.alloc(4),
        u32(0),
        u32(na),
        Buffer.concat(Array.from({ length: na }, () => u32(AUDIO_SAMPLE))),
      ),
      table('stco', ...offsets[2].map(u32)),
    );
    const audioTicks = na * 1024;
    const videoMs = nv * 100;
    const audioMs = Math.round((audioTicks / 44100) * 1000);
    return box(
      'moov',
      box(
        'mvhd',
        Buffer.alloc(4),
        u32(0),
        u32(0),
        u32(1000),
        u32(Math.max(videoMs, audioMs)),
        Buffer.alloc(80),
      ),
      box(
        'trak',
        tkhd(1, videoMs),
        box(
          'mdia',
          mdhd(1000, videoMs),
          hdlr('vide'),
          box(
            'minf',
            box('vmhd', Buffer.from([0, 0, 0, 1]), Buffer.alloc(8)),
            dinf,
            stblV,
          ),
        ),
      ),
      box(
        'trak',
        tkhd(2, audioMs),
        box(
          'mdia',
          mdhd(44100, audioTicks),
          hdlr('soun'),
          box('minf', box('smhd', Buffer.alloc(8)), dinf, stblA),
        ),
      ),
    );
  };
  if (opts.moovFirst) {
    const at = ftyp.length + moovFor(0).length + 8;
    return Buffer.concat([ftyp, moovFor(at), mdat]);
  }
  return Buffer.concat([ftyp, mdat, moovFor(ftyp.length + 8)]);
}

/** A source over a buffer, as the cutters read a stored file. */
export function sourceOf(file: Buffer): {
  length: number;
  read: (start: number, end: number) => Promise<Buffer>;
  reads: { start: number; end: number }[];
} {
  const reads: { start: number; end: number }[] = [];
  return {
    length: file.length,
    reads,
    read: (start, end) => {
      reads.push({ start, end });
      return Promise.resolve(file.subarray(start, Math.min(end, file.length)));
    },
  };
}
