/**
 * Small recordings and hostile files for the AI tools' length reader
 * (AITOOLS-04 round 2), built in memory. No file on disk, no ffmpeg.
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

/** An ISO base media box. */
export function box(type: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([
    u32(8 + body.length),
    Buffer.from(type, 'latin1'),
    body,
  ]);
}

/** A WAV file of `seconds` (8 kHz, 8 bit, mono), then `tail` (a stand-in marker). */
export function wavFile(seconds: number, tail = ''): Buffer {
  const rate = 8000;
  const size = Math.round(seconds * rate);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(36 + size, 4);
  head.write('WAVEfmt ', 8, 'latin1');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate, 28);
  head.writeUInt16LE(1, 32);
  head.writeUInt16LE(8, 34);
  head.write('data', 36, 'latin1');
  head.writeUInt32LE(size, 40);
  return Buffer.concat([head, Buffer.alloc(size, 128), Buffer.from(tail)]);
}

/** Silent MP3 frames (44.1 kHz, 128 kbps) of about `seconds`, then `tail`. */
export function mp3File(seconds: number, tail = ''): Buffer {
  const frame = Buffer.alloc(417);
  frame.writeUInt32BE(0xfffb9004, 0);
  const frames = Math.round(seconds / (1152 / 44100));
  return Buffer.concat([
    ...Array.from({ length: frames }, () => frame),
    Buffer.from(tail),
  ]);
}

/** ADTS AAC (LC, 44.1 kHz, stereo) frames of about `seconds`. */
export function adtsFile(seconds: number): Buffer {
  const len = 200;
  const frames = Math.round(seconds / (1024 / 44100));
  const f = Buffer.alloc(len);
  f[0] = 0xff;
  f[1] = 0xf1;
  f[2] = 0x50;
  f[3] = 0x80 | ((len >> 11) & 3);
  f[4] = (len >> 3) & 0xff;
  f[5] = ((len & 7) << 5) | 0x1f;
  f[6] = 0xfc;
  return Buffer.concat(Array.from({ length: frames }, () => f));
}

/**
 * An MP4, M4A or QuickTime file with one AAC audio track. `brand` is the
 * 'ftyp' brand (`isom`, `M4A `, `qt  `); `milliseconds` is the track's length
 * (the real 90 s file reads 90.064, so a "1:00" clip is 60064); `fragmented`
 * writes it as a browser or phone recorder does (an empty 'moov' with 'mvex'),
 * whose length reads 0.
 */
export function mp4File(opts: {
  brand?: string;
  milliseconds?: number;
  fragmented?: boolean;
}): Buffer {
  const brand = (opts.brand ?? 'isom').padEnd(4).slice(0, 4);
  const ms = opts.fragmented ? 0 : (opts.milliseconds ?? 90_000);
  const ftyp = box('ftyp', Buffer.from(brand), u32(0), Buffer.from(brand));
  const mvhd = box(
    'mvhd',
    Buffer.alloc(4),
    u32(0),
    u32(0),
    u32(1000),
    u32(ms),
    Buffer.alloc(80),
  );
  const tkhd = box(
    'tkhd',
    Buffer.from([0, 0, 0, 7]),
    u32(0),
    u32(0),
    u32(1),
    u32(0),
    u32(ms),
    Buffer.alloc(60),
  );
  const mdhd = box(
    'mdhd',
    Buffer.alloc(4),
    u32(0),
    u32(0),
    u32(1000),
    u32(ms),
    u16(0x55c4),
    u16(0),
  );
  const hdlr = box(
    'hdlr',
    Buffer.alloc(4),
    Buffer.alloc(4),
    Buffer.from('soun'),
    Buffer.alloc(12),
    Buffer.from('s\0'),
  );
  const desc = Buffer.concat([
    u16(0),
    u16(0),
    u32(0),
    u16(2),
    u16(16),
    u16(0),
    u16(0),
    u32(44100 * 65536),
  ]);
  const entry = Buffer.concat([
    Buffer.from('mp4a'),
    Buffer.alloc(6),
    u16(1),
    desc,
  ]);
  const stsd = box(
    'stsd',
    Buffer.alloc(4),
    u32(1),
    u32(entry.length + 4),
    entry,
  );
  const stbl = box('stbl', stsd, box('stts', Buffer.alloc(4), u32(0)));
  const trak = box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', stbl)));
  const moov = [mvhd, trak];
  if (opts.fragmented) moov.push(box('mvex', box('trex', Buffer.alloc(24))));
  return Buffer.concat([
    ftyp,
    box('moov', ...moov),
    box('mdat', Buffer.alloc(16)),
  ]);
}

/** A WebM file with one Opus audio track of `seconds`. */
export function webmFile(seconds: number): Buffer {
  const size = (n: number) =>
    Buffer.from([
      0x10 | ((n >> 24) & 0x0f),
      (n >> 16) & 0xff,
      (n >> 8) & 0xff,
      n & 0xff,
    ]);
  const el = (id: string, payload: Buffer) =>
    Buffer.concat([Buffer.from(id, 'hex'), size(payload.length), payload]);
  const f64 = (x: number) => {
    const b = Buffer.alloc(8);
    b.writeDoubleBE(x);
    return b;
  };
  const f32 = (x: number) => {
    const b = Buffer.alloc(4);
    b.writeFloatBE(x);
    return b;
  };
  const ebml = el(
    '1A45DFA3',
    Buffer.concat([
      el('4282', Buffer.from('webm')),
      el('4287', Buffer.from([4])),
      el('4285', Buffer.from([2])),
    ]),
  );
  const info = el(
    '1549A966',
    Buffer.concat([
      el('2AD7B1', Buffer.from([0x0f, 0x42, 0x40])),
      el('4489', f64(seconds * 1000)),
    ]),
  );
  const track = el(
    'AE',
    Buffer.concat([
      el('D7', Buffer.from([1])),
      el('73C5', Buffer.from([1])),
      el('83', Buffer.from([2])),
      el('86', Buffer.from('A_OPUS')),
      el(
        'E1',
        Buffer.concat([el('B5', f32(48000)), el('9F', Buffer.from([2]))]),
      ),
    ]),
  );
  return Buffer.concat([
    ebml,
    el('18538067', Buffer.concat([info, el('1654AE6B', track)])),
  ]);
}

/**
 * The verifier's crafted file (24 Oct 2026): an ASF header whose sub-object
 * has a size of zero, 278 bytes. `music-metadata` 7.14.0 reads it in an endless
 * loop when it is let sniff the type from the bytes (GHSA-v6c2-xwv6-8xf7).
 */
export function craftedAsf(): Buffer {
  const head = Buffer.alloc(30);
  Buffer.from('3026B2758E66CF11A6D900AA0062CE6C', 'hex').copy(head, 0);
  head.writeBigUInt64LE(278n, 16);
  head.writeUInt32LE(1, 24);
  head[28] = 1;
  head[29] = 2;
  const sub = Buffer.alloc(24); // an object whose size field is zero
  Buffer.from('A1DCAB8C47A9CF118EE400C00C205365', 'hex').copy(sub, 0);
  return Buffer.concat([head, sub, Buffer.alloc(278 - 54)]);
}

/** An ID3v2 tag with nothing in it, then `rest`: how an ASF file hides behind an MP3 header. */
export function withId3(rest: Buffer): Buffer {
  const h = Buffer.alloc(10);
  h.write('ID3', 0, 'latin1');
  h[3] = 3;
  return Buffer.concat([h, rest]);
}
