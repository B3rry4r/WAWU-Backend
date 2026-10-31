import {
  CutRefusal,
  MIN_SOURCE_SECONDS,
  previewSecondsFor,
  type CutResult,
  type CutSource,
} from './cut-types';

const MIB = 1024 * 1024;
/** The most of a file's index (its "moov") the cut reads. */
const MAX_MOOV = 48 * MIB;
/** The most sample bytes a preview may take (30 seconds of 4K video is about 100 MB). */
const MAX_SAMPLES = 160 * MIB;
/** Two runs of wanted bytes closer than this are read as one. */
const GAP = 256 * 1024;

interface Box {
  type: string;
  start: number;
  end: number;
  body: number;
}

const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
};
const box = (type: string, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  return Buffer.concat([
    u32(8 + body.length),
    Buffer.from(type, 'latin1'),
    body,
  ]);
};
const bad = () => new CutRefusal('unsupported');

/** The boxes inside `buf[from, to)`. */
function boxesIn(buf: Buffer, from: number, to: number): Box[] {
  const out: Box[] = [];
  let p = from;
  while (p + 8 <= to) {
    let size = buf.readUInt32BE(p);
    let head = 8;
    if (size === 1) {
      if (p + 16 > to) throw bad();
      size = buf.readUInt32BE(p + 8) * 2 ** 32 + buf.readUInt32BE(p + 12);
      head = 16;
    } else if (size === 0) size = to - p;
    if (size < head || p + size > to) throw bad();
    out.push({
      type: buf.toString('latin1', p + 4, p + 8),
      start: p,
      end: p + size,
      body: p + head,
    });
    p += size;
  }
  return out;
}

const child = (buf: Buffer, parent: Box, type: string): Box | undefined =>
  boxesIn(buf, parent.body, parent.end).find((b) => b.type === type);

/** Writes a duration into an mvhd, tkhd or mdhd (version 0 and 1 both). */
function setDuration(
  buf: Buffer,
  b: Box,
  kind: 'mvhd' | 'tkhd' | 'mdhd',
  ticks: number,
): void {
  const v1 = buf[b.body] === 1;
  const at = b.body + (kind === 'tkhd' ? (v1 ? 28 : 20) : v1 ? 24 : 16);
  if (v1) {
    buf.writeUInt32BE(Math.floor(ticks / 2 ** 32), at);
    buf.writeUInt32BE(ticks >>> 0, at + 4);
  } else buf.writeUInt32BE(Math.min(ticks, 0xffffffff) >>> 0, at);
}

const timescaleOf = (buf: Buffer, b: Box): number =>
  buf.readUInt32BE(b.body + (buf[b.body] === 1 ? 20 : 12));

interface Track {
  trak: Box;
  tkhd: Box;
  mdhd: Box;
  hdlr: Box;
  minf: Box;
  stbl: Box;
  stsd: Box;
  timescale: number;
  stts: [number, number][];
  ctts: Buffer | null;
  stss: Buffer | null;
  sizes: Buffer;
  uniform: number;
  count: number;
  stsc: [number, number, number][];
  offsets: number[];
  totalTicks: number;
}

function readTrack(m: Buffer, trak: Box): Track | null {
  const tkhd = child(m, trak, 'tkhd');
  const mdia = child(m, trak, 'mdia');
  if (!tkhd || !mdia) return null;
  const mdhd = child(m, mdia, 'mdhd');
  const hdlr = child(m, mdia, 'hdlr');
  const minf = child(m, mdia, 'minf');
  if (!mdhd || !hdlr || !minf) return null;
  const handler = m.toString('latin1', hdlr.body + 8, hdlr.body + 12);
  if (handler !== 'vide' && handler !== 'soun') return null;
  const stbl = child(m, minf, 'stbl');
  if (!stbl) throw bad();
  const t = (type: string) => child(m, stbl, type);
  const stsd = t('stsd');
  const stts = t('stts');
  const stsz = t('stsz');
  const stsc = t('stsc');
  const stco = t('stco');
  const co64 = t('co64');
  if (!stsd || !stts || !stsz || !stsc || (!stco && !co64)) throw bad();
  const rows = (b: Box, width: number) => {
    const n = m.readUInt32BE(b.body + 4);
    if (b.body + 8 + n * width > b.end) throw bad();
    return n;
  };
  const sttsRows: [number, number][] = [];
  const sn = rows(stts, 8);
  let totalTicks = 0;
  for (let i = 0; i < sn; i += 1) {
    const c = m.readUInt32BE(stts.body + 8 + i * 8);
    const d = m.readUInt32BE(stts.body + 12 + i * 8);
    sttsRows.push([c, d]);
    totalTicks += c * d;
  }
  const uniform = m.readUInt32BE(stsz.body + 4);
  const count = m.readUInt32BE(stsz.body + 8);
  if (uniform === 0 && stsz.body + 12 + count * 4 > stsz.end) throw bad();
  const cn = rows(stsc, 12);
  const stscRows: [number, number, number][] = [];
  for (let i = 0; i < cn; i += 1) {
    const at = stsc.body + 8 + i * 12;
    stscRows.push([
      m.readUInt32BE(at),
      m.readUInt32BE(at + 4),
      m.readUInt32BE(at + 8),
    ]);
  }
  const offsets: number[] = [];
  if (stco) {
    const n = rows(stco, 4);
    for (let i = 0; i < n; i += 1)
      offsets.push(m.readUInt32BE(stco.body + 8 + i * 4));
  } else if (co64) {
    const n = rows(co64, 8);
    for (let i = 0; i < n; i += 1) {
      const at = co64.body + 8 + i * 8;
      offsets.push(m.readUInt32BE(at) * 2 ** 32 + m.readUInt32BE(at + 4));
    }
  }
  const ctts = t('ctts');
  const stss = t('stss');
  return {
    trak,
    tkhd,
    mdhd,
    hdlr,
    minf,
    stbl,
    stsd,
    timescale: timescaleOf(m, mdhd),
    stts: sttsRows,
    ctts: ctts ? m.subarray(ctts.body + 4, ctts.end) : null,
    stss: stss ? m.subarray(stss.body + 4, stss.end) : null,
    sizes:
      uniform === 0
        ? m.subarray(stsz.body + 12, stsz.body + 12 + count * 4)
        : Buffer.alloc(0),
    uniform,
    count,
    stsc: stscRows,
    offsets,
    totalTicks,
  };
}

interface Cut {
  track: Track;
  /** How many samples are kept. */
  n: number;
  /** The ticks they last. */
  ticks: number;
  /** Each kept sample's place in the original file, and its size. */
  at: number[];
  size: number[];
}

/** The first samples of `track` that start before `limitTicks`, and where they sit in the file. */
function cutTrack(m: Buffer, track: Track, limitTicks: number): Cut | null {
  let n = 0;
  let ticks = 0;
  outer: for (const [c, d] of track.stts) {
    for (let i = 0; i < c; i += 1) {
      if (ticks >= limitTicks || n >= track.count) break outer;
      ticks += d;
      n += 1;
    }
  }
  if (n === 0) return null;
  const sizeOf = (i: number) =>
    track.uniform !== 0 ? track.uniform : track.sizes.readUInt32BE(i * 4);
  const at: number[] = [];
  const size: number[] = [];
  let chunk = 0;
  let s = 0;
  for (let r = 0; r < track.stsc.length && s < n; r += 1) {
    const [first, per, desc] = track.stsc[r];
    if (desc !== 1) throw bad();
    const last =
      r + 1 < track.stsc.length
        ? track.stsc[r + 1][0] - 1
        : track.offsets.length;
    for (chunk = first; chunk <= last && s < n; chunk += 1) {
      let place = track.offsets[chunk - 1];
      if (place === undefined) throw bad();
      for (let k = 0; k < per && s < n; k += 1, s += 1) {
        at.push(place);
        size.push(sizeOf(s));
        place += sizeOf(s);
      }
    }
  }
  if (at.length !== n) throw bad();
  return { track, n, ticks, at, size };
}

/** The rebuilt sample tables of a kept track (each sample its own chunk, in the new mdat). */
function newStbl(m: Buffer, cut: Cut, newOffsets: number[]): Buffer {
  const { track, n } = cut;
  const head = Buffer.alloc(4);
  // stts, cut to `n` samples
  const runs: Buffer[] = [];
  let left = n;
  for (const [c, d] of track.stts) {
    if (left <= 0) break;
    const take = Math.min(c, left);
    runs.push(u32(take), u32(d));
    left -= take;
  }
  const parts: Buffer[] = [
    m.subarray(track.stsd.start, track.stsd.end),
    box('stts', head, u32(runs.length / 2), ...runs),
  ];
  if (track.ctts) {
    const cn = track.ctts.readUInt32BE(0);
    const rowsOut: Buffer[] = [];
    let want = n;
    for (let i = 0; i < cn && want > 0; i += 1) {
      const c = track.ctts.readUInt32BE(4 + i * 8);
      const take = Math.min(c, want);
      rowsOut.push(u32(take), track.ctts.subarray(8 + i * 8, 12 + i * 8));
      want -= take;
    }
    parts.push(
      box(
        'ctts',
        Buffer.from([findVersion(m, track, 'ctts'), 0, 0, 0]),
        u32(rowsOut.length / 2),
        ...rowsOut,
      ),
    );
  }
  if (track.stss) {
    const sn = track.stss.readUInt32BE(0);
    const kept: Buffer[] = [];
    for (let i = 0; i < sn; i += 1) {
      const v = track.stss.readUInt32BE(4 + i * 4);
      if (v <= n) kept.push(u32(v));
    }
    if (kept.length === 0) throw bad();
    parts.push(box('stss', head, u32(kept.length), ...kept));
  }
  parts.push(box('stsc', head, u32(1), u32(1), u32(1), u32(1)));
  const sizes = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i += 1) sizes.writeUInt32BE(cut.size[i], i * 4);
  parts.push(box('stsz', head, u32(0), u32(n), sizes));
  const offs = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i += 1) offs.writeUInt32BE(newOffsets[i] >>> 0, i * 4);
  parts.push(box('stco', head, u32(n), offs));
  return box('stbl', ...parts);
}

/** The version byte of a table the track has (ctts v1 holds signed offsets, which are copied as they are). */
function findVersion(m: Buffer, track: Track, type: string): number {
  const b = child(m, track.stbl, type);
  return b ? m[b.body] : 0;
}

/**
 * The first seconds of an MP4 or QuickTime video (video and sound tracks, no
 * re-encoding): the samples that start inside the preview's length are copied
 * into a new file whose index is rebuilt for them, with the index first so it
 * plays as it downloads. A file written in fragments (a browser or some
 * recorders) and one with a second sample description are refused, so the
 * creator uses their own clip.
 */
export async function cutMp4(source: CutSource): Promise<CutResult> {
  // 1. The top-level boxes: where the index ("moov") is.
  let p = 0;
  let ftyp: Buffer | null = null;
  let moov: { start: number; end: number } | null = null;
  for (let seen = 0; p + 8 <= source.length && seen < 64; seen += 1) {
    const h = await source.read(p, Math.min(source.length, p + 16));
    let size = h.readUInt32BE(0);
    const type = h.toString('latin1', 4, 8);
    if (size === 1) {
      if (h.length < 16) throw bad();
      size = h.readUInt32BE(8) * 2 ** 32 + h.readUInt32BE(12);
    } else if (size === 0) size = source.length - p;
    if (size < 8 || p + size > source.length) throw bad();
    if (type === 'moof') throw bad();
    if (type === 'ftyp' && size <= 4096 && !ftyp)
      ftyp = await source.read(p, p + size);
    if (type === 'moov') {
      moov = { start: p, end: p + size };
      break;
    }
    p += size;
  }
  if (!moov) throw bad();
  if (moov.end - moov.start > MAX_MOOV) throw new CutRefusal('too_big');
  const m = await source.read(moov.start, moov.end);
  if (m.length !== moov.end - moov.start) throw bad();
  const kids = boxesIn(m, 8, m.length);
  if (kids.some((k) => k.type === 'mvex')) throw bad();
  const mvhd = kids.find((k) => k.type === 'mvhd');
  if (!mvhd) throw bad();
  const tracks = kids
    .filter((k) => k.type === 'trak')
    .map((k) => readTrack(m, k))
    .filter((t): t is Track => t !== null);
  if (tracks.length === 0) throw bad();
  // 2. How long the file is, and how much of it the preview takes.
  const sourceSeconds = Math.max(
    ...tracks.map((t) => t.totalTicks / t.timescale),
  );
  if (!(sourceSeconds >= MIN_SOURCE_SECONDS)) throw new CutRefusal('too_short');
  const want = previewSecondsFor(sourceSeconds);
  const cuts = tracks
    .map((t) => cutTrack(m, t, want * t.timescale))
    .filter((c): c is Cut => c !== null);
  if (cuts.length === 0) throw bad();
  // 3. Read the wanted samples: runs of them, in file order.
  const all = cuts.flatMap((c, ci) =>
    c.at.map((at, i) => ({ ci, i, at, size: c.size[i] })),
  );
  all.sort((a, b) => a.at - b.at);
  const runs: { from: number; to: number }[] = [];
  let total = 0;
  for (const s of all) {
    const last = runs[runs.length - 1];
    if (last && s.at <= last.to + GAP)
      last.to = Math.max(last.to, s.at + s.size);
    else runs.push({ from: s.at, to: s.at + s.size });
  }
  for (const r of runs) total += r.to - r.from;
  if (total > MAX_SAMPLES) throw new CutRefusal('too_big');
  const read: Buffer[] = [];
  for (const r of runs) {
    const b = await source.read(r.from, r.to);
    if (b.length !== r.to - r.from) throw bad();
    read.push(b);
  }
  const payload: Buffer[] = [];
  const placed = cuts.map((c) => new Array<number>(c.n).fill(0));
  let used = 0;
  let run = 0;
  for (const s of all) {
    while (s.at >= runs[run].to) run += 1;
    const from = s.at - runs[run].from;
    payload.push(read[run].subarray(from, from + s.size));
    placed[s.ci][s.i] = used;
    used += s.size;
  }
  // 4. The new index. Built once to learn its size, then again with the real offsets.
  const kind =
    ftyp && ftyp.toString('latin1', 8, 12) !== 'qt  '
      ? ftyp
      : box('ftyp', Buffer.from('isom'), u32(512), Buffer.from('isomiso2mp41'));
  const movieScale = timescaleOf(m, mvhd);
  const build = (mdatAt: number): Buffer => {
    const mv = Buffer.from(m.subarray(mvhd.start, mvhd.end));
    const movieTicks = Math.max(
      ...cuts.map((c) =>
        Math.round((c.ticks * movieScale) / c.track.timescale),
      ),
    );
    setDuration(
      mv,
      { ...mvhd, start: 0, end: mv.length, body: mvhd.body - mvhd.start },
      'mvhd',
      movieTicks,
    );
    const traks = cuts.map((c, ci) => {
      const t = c.track;
      const tk = Buffer.from(m.subarray(t.tkhd.start, t.tkhd.end));
      setDuration(
        tk,
        {
          ...t.tkhd,
          start: 0,
          end: tk.length,
          body: t.tkhd.body - t.tkhd.start,
        },
        'tkhd',
        Math.round((c.ticks * movieScale) / t.timescale),
      );
      const md = Buffer.from(m.subarray(t.mdhd.start, t.mdhd.end));
      setDuration(
        md,
        {
          ...t.mdhd,
          start: 0,
          end: md.length,
          body: t.mdhd.body - t.mdhd.start,
        },
        'mdhd',
        c.ticks,
      );
      const stbl = newStbl(
        m,
        c,
        placed[ci].map((o) => mdatAt + o),
      );
      const minf = box(
        'minf',
        ...boxesIn(m, t.minf.body, t.minf.end).map((b) =>
          b.type === 'stbl' ? stbl : m.subarray(b.start, b.end),
        ),
      );
      return box(
        'trak',
        tk,
        box('mdia', md, m.subarray(t.hdlr.start, t.hdlr.end), minf),
      );
    });
    return box('moov', mv, ...traks);
  };
  const moovSize = build(0).length;
  const mdatAt = kind.length + moovSize + 8;
  const body = Buffer.concat([kind, build(mdatAt), box('mdat', ...payload)]);
  const seconds = Math.max(...cuts.map((c) => c.ticks / c.track.timescale));
  return { body, contentType: 'video/mp4', seconds, sourceSeconds };
}
