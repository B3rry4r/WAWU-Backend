// VIDEO-PRIVACY (R-127): the cleaner takes the location, device and time tags
// out of a video without changing its size or any offset in it. These files are
// built here box by box, so the spec needs no ffmpeg; the real-file matrix (made
// with ffmpeg, proved with ffprobe) is in video-privacy-ffmpeg.spec.ts.
import { planClean } from '../video-privacy/clean-video';
import { applyToBuffer, patchStream } from '../video-privacy/apply-patches';
import { Unreadable, type VideoSource } from '../video-privacy/types';

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};
const u64 = (n: number) => {
  const b = Buffer.alloc(8);
  b.writeUInt32BE(Math.floor(n / 2 ** 32), 0);
  b.writeUInt32BE(n >>> 0, 4);
  return b;
};
const box = (type: string, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([
    u32(8 + body.length),
    Buffer.from(type, 'latin1'),
    body,
  ]);
};
const box64 = (type: string, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([
    u32(1),
    Buffer.from(type, 'latin1'),
    u64(16 + body.length),
    body,
  ]);
};
const full = (type: string, version: number, ...parts: Buffer[]) =>
  box(type, Buffer.from([version, 0, 0, 0]), ...parts);
const CREATED = 3_800_000_000;
const LOCATION = '+06.4542+003.3925/';

const hdlr = (kind: string) =>
  full(
    'hdlr',
    0,
    u32(0),
    Buffer.from(kind, 'latin1'),
    Buffer.alloc(12),
    Buffer.from('X\0'),
  );
const stbl = (sizes: number[], offset: number) =>
  box(
    'stbl',
    full('stsd', 0, u32(0)),
    full('stsz', 0, u32(0), u32(sizes.length), ...sizes.map(u32)),
    full('stsc', 0, u32(1), u32(1), u32(sizes.length), u32(1)),
    full('stco', 0, u32(1), u32(offset)),
  );
const times = (v1: boolean) =>
  v1
    ? Buffer.concat([u64(CREATED), u64(CREATED)])
    : Buffer.concat([u32(CREATED), u32(CREATED)]);
const tags = () =>
  Buffer.concat([
    box(
      'udta',
      box('©xyz', Buffer.from(LOCATION)),
      box('©mak', Buffer.from('Apple')),
      box('©mod', Buffer.from('iPhone 15 Pro')),
    ),
    box(
      'meta',
      hdlr('mdta'),
      box(
        'keys',
        Buffer.from('com.apple.quicktime.location.ISO6709 ' + LOCATION),
      ),
      box('ilst', Buffer.from(LOCATION)),
    ),
  ]);

interface Opts {
  moovFirst?: boolean;
  v1?: boolean;
  big?: boolean;
  fragmented?: boolean;
  gpsTrack?: boolean;
  topTags?: boolean;
}

function build(o: Opts = {}) {
  const VIDEO = Buffer.from('VIDEOSAMPLES-0123456789');
  const GPS = Buffer.from('GPS+06.4542+003.3925');
  const mdatBody = Buffer.concat([VIDEO, GPS]);
  const ftyp = box(
    'ftyp',
    Buffer.from('isom'),
    u32(512),
    Buffer.from('isomiso2'),
  );
  const mk = (mdatAt: number) => {
    const tk = (id: number, kind: string, sizes: number[], off: number) =>
      box(
        'trak',
        full('tkhd', o.v1 ? 1 : 0, times(!!o.v1), u32(id), Buffer.alloc(60)),
        box(
          'mdia',
          full(
            'mdhd',
            o.v1 ? 1 : 0,
            times(!!o.v1),
            u32(1000),
            u32(1000),
            u32(0),
          ),
          hdlr(kind),
          box('minf', stbl(sizes, off)),
        ),
        box('udta', box('name', Buffer.from('cam'))),
      );
    const traks = [tk(1, 'vide', [VIDEO.length], mdatAt)];
    if (o.gpsTrack) traks.push(tk(2, 'mebx', [10, 10], mdatAt + VIDEO.length));
    const moovBody = [
      full(
        'mvhd',
        o.v1 ? 1 : 0,
        times(!!o.v1),
        u32(1000),
        u32(1000),
        Buffer.alloc(80),
      ),
      ...traks,
      tags(),
      box('free', Buffer.from('OLD-TAG-LEFT-IN-PADDING')),
      ...(o.fragmented
        ? [box('mvex', full('trex', 0, u32(1), u32(1), u32(0), u32(0), u32(0)))]
        : []),
    ];
    return (o.big ? box64 : box)('moov', ...moovBody);
  };
  const top = o.topTags
    ? [
        box('udta', box('©xyz', Buffer.from(LOCATION))),
        box(
          'uuid',
          Buffer.from('be7acfcb97a942e89c71999491e3afac', 'hex'),
          Buffer.from('<x:xmpmeta>' + LOCATION),
        ),
      ]
    : [];
  const mdatHead = (o.big ? box64 : box)('mdat', mdatBody).subarray(
    0,
    o.big ? 16 : 8,
  );
  let file: Buffer;
  if (o.moovFirst) {
    const size = mk(0).length;
    const at = ftyp.length + size + mdatHead.length;
    file = Buffer.concat([ftyp, mk(at), mdatHead, mdatBody, ...top]);
  } else {
    const at = ftyp.length + mdatHead.length;
    file = Buffer.concat([ftyp, mdatHead, mdatBody, mk(at), ...top]);
  }
  if (o.fragmented)
    file = Buffer.concat([file, box('moof', full('mfhd', 0, u32(1)))]);
  return { file, mdatBody, VIDEO, GPS };
}

const src = (file: Buffer): VideoSource => ({
  length: file.length,
  read: (a, b) => Promise.resolve(file.subarray(a, Math.min(b, file.length))),
});
const has = (b: Buffer, s: string) => b.includes(Buffer.from(s, 'latin1'));

async function clean(file: Buffer, name = 'v.mp4') {
  const plan = await planClean(name, src(file));
  return { plan, out: plan ? applyToBuffer(file, plan.patches) : file };
}

describe('VIDEO-PRIVACY: the MP4 and QuickTime cleaner', () => {
  const cases: [string, Opts][] = [
    ['moov at the end', {}],
    ['moov at the start', { moovFirst: true }],
    [
      '64-bit box sizes (mdat and moov), version 1 times',
      { big: true, v1: true },
    ],
    ['64-bit sizes, moov first', { big: true, moovFirst: true }],
    ['fragmented', { fragmented: true }],
  ];
  it.each(cases)(
    '%s: no location, make or model; same size; boxes and offsets intact',
    async (_n, o) => {
      const { file, VIDEO } = build(o);
      expect(has(file, LOCATION)).toBe(true);
      const { plan, out } = await clean(file);
      expect(plan!.patches.length).toBeGreaterThan(0);
      expect(out.length).toBe(file.length);
      for (const s of [
        LOCATION,
        'Apple',
        'iPhone',
        'OLD-TAG',
        'quicktime.location',
      ])
        expect(has(out, s)).toBe(false);
      // The samples are where they were and untouched.
      expect(out.includes(VIDEO)).toBe(true);
      expect(out.indexOf(VIDEO)).toBe(file.indexOf(VIDEO));
      // Only moov (and the tail of a fragmented file's boxes) differ; the front is byte for byte.
      const mdatAt = file.indexOf(Buffer.from('mdat', 'latin1'));
      expect(
        out.subarray(0, mdatAt + 4).equals(file.subarray(0, mdatAt + 4)) ||
          o.moovFirst,
      ).toBe(true);
    },
  );

  it('zeroes the creation and modification times in mvhd, tkhd and mdhd (version 0 and 1)', async () => {
    for (const v1 of [false, true]) {
      const { file } = build({ v1 });
      const { out } = await clean(file);
      const stamp = v1 ? u64(CREATED) : u32(CREATED);
      expect(out.includes(stamp)).toBe(false);
      expect(file.includes(stamp)).toBe(true);
    }
  });

  it('turns udta and meta into free boxes of the same size, and top-level tags and XMP too', async () => {
    const { file } = build({ topTags: true });
    const { out, plan } = await clean(file);
    expect(plan!.removed).toEqual(
      expect.arrayContaining([
        'moov/udta',
        'moov/meta',
        'trak/udta',
        'top/udta',
        'top/uuid',
      ]),
    );
    expect(has(out, 'xmpmeta')).toBe(false);
    expect(out.length).toBe(file.length);
  });

  it('removes a timed-metadata track and zeroes its samples, leaving the video track', async () => {
    const { file, GPS, VIDEO } = build({ gpsTrack: true });
    expect(file.includes(GPS)).toBe(true);
    const { out, plan } = await clean(file);
    expect(plan!.removed.join()).toMatch(/trak\/mebx/);
    expect(out.includes(GPS)).toBe(false);
    expect(has(out, '6.4542')).toBe(false);
    expect(out.includes(VIDEO)).toBe(true);
    expect(out.indexOf(VIDEO)).toBe(file.indexOf(VIDEO));
  });

  it('leaves a metadata track of a fragmented file and says so', async () => {
    const { file } = build({ gpsTrack: true, fragmented: true });
    const { plan } = await clean(file);
    expect(plan!.notes.join()).toMatch(/left: file is fragmented/);
  });

  it('is idempotent: a clean file yields no patches', async () => {
    for (const o of [
      {},
      { moovFirst: true },
      { big: true, v1: true, gpsTrack: true, topTags: true },
    ]) {
      const first = await clean(build(o).file);
      const again = await planClean('v.mov', src(first.out));
      expect(again!.patches).toEqual([]);
    }
  });

  it('refuses what it cannot read, and a cut-short file, without a patch', async () => {
    const { file } = build();
    await expect(
      planClean('v.mp4', src(Buffer.from('not a video at all, just text.'))),
    ).rejects.toBeInstanceOf(Unreadable);
    await expect(
      planClean('v.mp4', src(file.subarray(0, file.length - 30))),
    ).rejects.toBeInstanceOf(Unreadable);
    expect(await planClean('v.pdf', src(file))).toBeNull();
  });

  it('patchStream gives the same bytes as applying the patches, however the file is cut into chunks', async () => {
    const { file } = build({ gpsTrack: true, topTags: true });
    const { plan, out } = await clean(file);
    for (const size of [1, 7, 64, 1000, file.length]) {
      const s = patchStream(plan!.patches);
      const got: Buffer[] = [];
      s.on('data', (c: Buffer) => got.push(c));
      for (let i = 0; i < file.length; i += size)
        s.write(file.subarray(i, i + size));
      await new Promise((r) => s.end(r));
      expect(Buffer.concat(got).equals(out)).toBe(true);
    }
  });
});

describe('VIDEO-PRIVACY: the WebM cleaner', () => {
  const vint = (n: number, len: number) => {
    const b = Buffer.alloc(len);
    let v = BigInt(n) + (1n << BigInt(7 * len));
    for (let i = len - 1; i >= 0; i -= 1) {
      b[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    return b;
  };
  const el = (id: string, payload: Buffer) =>
    Buffer.concat([
      Buffer.from(id, 'hex'),
      vint(payload.length, 1 + Math.floor(payload.length / 120)),
      payload,
    ]);
  const webm = (unknownCluster = false) =>
    Buffer.concat([
      el('1a45dfa3', Buffer.from('webm')),
      el(
        '18538067',
        Buffer.concat([
          el(
            '1549a966',
            Buffer.concat([
              el('4461', Buffer.from('0123456789abcdef'.slice(0, 8))),
              el('4d80', Buffer.from('Lavf')),
              el('7ba9', Buffer.from('Alice at home')),
              el('5741', Buffer.from('PhoneCam 3')),
            ]),
          ),
          el('1654ae6b', Buffer.from('tracks')),
          unknownCluster
            ? Buffer.concat([
                Buffer.from('1f43b675', 'hex'),
                Buffer.from('01ffffffffffffff', 'hex'),
                Buffer.from('frames'),
              ])
            : el('1f43b675', Buffer.from('frames')),
          el('1254c367', Buffer.from('LOCATION ' + LOCATION + ' MAKE Apple')),
          el('1941a469', Buffer.from('attached picture with gps')),
        ]),
      ),
    ]);

  it('voids Tags and Attachments at the same size and zeroes DateUTC', async () => {
    const file = webm();
    const { plan, out } = await clean(file, 'v.webm');
    expect(plan!.removed).toEqual(
      expect.arrayContaining([
        'Tags',
        'Attachments',
        'DateUTC',
        'Title',
        'MuxingApp',
        'WritingApp',
      ]),
    );
    expect(out.length).toBe(file.length);
    for (const s of [
      LOCATION,
      'Apple',
      'gps',
      '01234567',
      'Alice',
      'PhoneCam',
      'Lavf',
    ])
      expect(has(out, s)).toBe(false);
    expect(has(out, 'frames')).toBe(true);
    expect((await planClean('v.webm', src(out)))!.patches).toEqual([]);
  });

  it('stops at a cluster of unknown size and says so (a live recording has no tags after it)', async () => {
    const { plan } = await clean(webm(true), 'v.webm');
    expect(plan!.notes.join()).toMatch(/unknown size/);
  });
});

describe('VIDEO-PRIVACY round 1: crafted tables, leftovers and cut-short files', () => {
  it('a crafted sample table (0xFFFFFFFF samples per chunk and in the count) is given up on in milliseconds', async () => {
    const { file } = build({ gpsTrack: true });
    const crafted = Buffer.from(file);
    const stsz = crafted.lastIndexOf(Buffer.from('stsz'));
    const stsc = crafted.lastIndexOf(Buffer.from('stsc'));
    crafted.writeUInt32BE(1, stsz + 4 + 4); // one size for all
    crafted.writeUInt32BE(0xffffffff, stsz + 4 + 8); // count
    crafted.writeUInt32BE(0xffffffff, stsc + 4 + 12); // samples per chunk
    const t = Date.now();
    const { plan, out } = await clean(crafted);
    expect(Date.now() - t).toBeLessThan(500);
    expect(plan!.notes.join()).toMatch(
      /mebx track left: its samples could not be placed/,
    );
    expect(plan!.removed.join()).not.toMatch(/mebx/);
    // The rest is still cleaned.
    expect(has(out, LOCATION)).toBe(false);
    expect(out.length).toBe(crafted.length);
  });

  it('a count that exceeds the sizes in the table, or a chunk past the end of the file, leaves the track', async () => {
    const { file } = build({ gpsTrack: true });
    const a = Buffer.from(file);
    a.writeUInt32BE(5000, a.lastIndexOf(Buffer.from('stsz')) + 4 + 8);
    expect((await clean(a)).plan!.notes.join()).toMatch(/could not be placed/);
    const b = Buffer.from(file);
    b.writeUInt32BE(
      file.length - 4,
      b.lastIndexOf(Buffer.from('stco')) + 4 + 8,
    );
    expect((await clean(b)).plan!.notes.join()).toMatch(/could not be placed/);
  });

  it('zeroes an unknown top-level uuid, top-level free and skip text, and a trailer after the last box', async () => {
    const { file } = build();
    const dirty = Buffer.concat([
      file,
      box('uuid', Buffer.alloc(16, 7), Buffer.from('device SM-S918B GPS')),
      box('skip', Buffer.from('skip text SM-S918B')),
      box('free', Buffer.from('free text SM-S918B')),
      Buffer.from('trailer SEFT SM-S918B'),
    ]);
    const { plan, out } = await clean(dirty);
    expect(has(out, 'SM-S918B')).toBe(false);
    expect(plan!.removed).toEqual(
      expect.arrayContaining(['top/uuid', 'trailer']),
    );
    expect(out.length).toBe(dirty.length);
    const mdatEnd = file.indexOf(Buffer.from('moov')) - 4;
    expect(out.subarray(0, mdatEnd).equals(dirty.subarray(0, mdatEnd))).toBe(
      true,
    );
    expect((await planClean('v.mp4', src(out)))!.patches).toEqual([]);
  });

  it('bytes that start like a box after moov mean a cut-short file: it is left, not zeroed', async () => {
    const { file } = build({ moovFirst: true });
    const cut = file.subarray(0, file.length - 10); // mdat now claims more than the file holds
    await expect(planClean('v.mp4', src(cut))).rejects.toBeInstanceOf(
      Unreadable,
    );
  });

  it('a moov of thousands of tiny boxes is refused', async () => {
    const { file } = build();
    const moovAt = file.indexOf(Buffer.from('moov')) - 4;
    const tiny = Buffer.concat(
      Array.from({ length: 110_000 }, () => box('free')),
    );
    const moov = box('moov', tiny);
    const big = Buffer.concat([file.subarray(0, moovAt), moov]);
    await expect(planClean('v.mp4', src(big))).rejects.toBeInstanceOf(
      Unreadable,
    );
  });
});

describe('VIDEO-PRIVACY round 2: the WebM walk has a budget', () => {
  it('gives up (the file is left) when the reads are slow, instead of walking on for minutes', async () => {
    const el = (id: string, payload: Buffer) =>
      Buffer.concat([
        Buffer.from(id, 'hex'),
        Buffer.from([0x80 | payload.length]),
        payload,
      ]);
    const clusters = Array.from({ length: 900 }, () =>
      el('1f43b675', Buffer.from('xx')),
    );
    const body = Buffer.concat([el('1549a966', Buffer.from('')), ...clusters]);
    const seg = Buffer.concat([
      Buffer.from('18538067', 'hex'),
      Buffer.from([0x01, 0, 0, 0, 0, 0, 0, 0]).fill(0, 1),
    ]);
    // A segment of known size: 8-byte size field.
    const sizeField = Buffer.alloc(8);
    sizeField[0] = 0x01;
    sizeField.writeUIntBE(body.length, 2, 6);
    const file = Buffer.concat([
      el('1a45dfa3', Buffer.from('webm')),
      seg.subarray(0, 4),
      sizeField,
      body,
    ]);
    const slow: VideoSource = {
      length: file.length,
      read: async (a, b) => {
        await new Promise((r) => setTimeout(r, 5));
        return file.subarray(a, Math.min(b, file.length));
      },
    };
    const t = Date.now();
    await expect(planClean('v.webm', slow)).rejects.toBeInstanceOf(Unreadable);
    expect(Date.now() - t).toBeLessThan(4000);
  });
});
