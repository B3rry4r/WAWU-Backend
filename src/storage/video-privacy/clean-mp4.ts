import {
  checkPatches,
  Unreadable,
  type CleanPlan,
  type Patch,
  type VideoSource,
} from './types';

/**
 * VIDEO-PRIVACY (R-127): the privacy plan for an MP4 or QuickTime file. No
 * ffmpeg, no re-encode, no offset rewrite: every change keeps the size of the
 * bytes it replaces, so the sample tables and chunk offsets stay valid and the
 * file plays as before.
 *
 *  - `udta` and `meta` boxes (location tags such as `©xyz`, the iPhone
 *    `com.apple.quicktime.location.ISO6709`, make, model, software) under
 *    `moov`, under each `trak`, and at the top of the file, and XMP boxes
 *    (`XMP_`, or a `uuid` box with the XMP id), become `free` boxes with zeroed
 *    bodies;
 *  - the creation and modification times in `mvhd`, `tkhd` and `mdhd` are zero;
 *  - the body of any `free` or `skip` box inside `moov` is zeroed (an editor
 *    may have turned a tag into padding without clearing it);
 *  - a timed-metadata track (handler `meta`, `mebx`, `gpmd`, `camm`: GPS and
 *    motion samples) becomes a `free` box and its samples are zeroed in `mdat`,
 *    when the file is not fragmented and the samples are where the index says.
 *
 * Reading is by ranges: the top-level box headers, then `moov` (at the start or
 * the end of the file, 32 or 64-bit sizes). A fragmented file gets the same
 * `moov` clean; its `moof` boxes are not walked.
 */
const MIB = 1024 * 1024;
const MAX_MOOV = 64 * MIB;
const MAX_TOP_BOXES = 64;
const MAX_CHUNKS_READ = 200_000;
const XMP_UUID = Buffer.from('be7acfcb97a942e89c71999491e3afac', 'hex');
const METADATA_HANDLERS = new Set(['meta', 'mebx', 'gpmd', 'camm']);
const TAG_BOXES = new Set(['udta', 'meta', 'XMP_']);

interface Box {
  type: string;
  start: number;
  end: number;
  body: number;
}

const bad = (why: string) => new Unreadable(why);

function boxesIn(buf: Buffer, from: number, to: number): Box[] {
  const out: Box[] = [];
  let p = from;
  while (p + 8 <= to) {
    let size = buf.readUInt32BE(p);
    let head = 8;
    if (size === 1) {
      if (p + 16 > to) throw bad('box header cut short');
      size = buf.readUInt32BE(p + 8) * 2 ** 32 + buf.readUInt32BE(p + 12);
      head = 16;
    } else if (size === 0) size = to - p;
    if (size < head || p + size > to) throw bad('box size outside its parent');
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

const kids = (buf: Buffer, b: Box) => boxesIn(buf, b.body, b.end);

/** The box becomes `free` with a zeroed body, same size, same header width. */
function freeify(buf: Buffer, b: Box): void {
  buf.write('free', b.start + 4, 'latin1');
  buf.fill(0, b.body, b.end);
}

function zeroTimes(buf: Buffer, b: Box): void {
  const v1 = buf[b.body] === 1;
  const end = b.body + 4 + (v1 ? 16 : 8);
  if (end > b.end) throw bad('header box too short');
  buf.fill(0, b.body + 4, end);
}

const isXmpUuid = (buf: Buffer, b: Box) =>
  b.type === 'uuid' &&
  b.body + 16 <= b.end &&
  buf.subarray(b.body, b.body + 16).equals(XMP_UUID);

interface TopBox extends Box {
  headLen: number;
}

async function readHeader(source: VideoSource, p: number): Promise<TopBox> {
  const h = await source.read(p, Math.min(source.length, p + 16));
  if (h.length < 8) throw bad('box header cut short');
  let size = h.readUInt32BE(0);
  let head = 8;
  const type = h.toString('latin1', 4, 8);
  if (size === 1) {
    if (h.length < 16) throw bad('box header cut short');
    size = h.readUInt32BE(8) * 2 ** 32 + h.readUInt32BE(12);
    head = 16;
  } else if (size === 0) size = source.length - p;
  if (size < head || p + size > source.length)
    throw bad('box size outside the file');
  return { type, start: p, end: p + size, body: p + head, headLen: head };
}

export async function planMp4(source: VideoSource): Promise<CleanPlan> {
  const patches: Patch[] = [];
  const removed: string[] = [];
  const notes: string[] = [];
  const tops: TopBox[] = [];
  let fragmented = false;
  let trailing = false;

  // 1. The top-level boxes, by their headers only.
  let p = 0;
  for (
    let seen = 0;
    p + 8 <= source.length && seen < MAX_TOP_BOXES;
    seen += 1
  ) {
    let b: TopBox;
    try {
      b = await readHeader(source, p);
    } catch (e) {
      if (tops.some((t) => t.type === 'moov') && tops.length > 0) {
        trailing = true;
        break;
      }
      throw e;
    }
    if (
      tops.length === 0 &&
      b.type !== 'ftyp' &&
      b.type !== 'moov' &&
      b.type !== 'wide' &&
      b.type !== 'free' &&
      b.type !== 'skip' &&
      b.type !== 'mdat'
    ) {
      throw bad('not an MP4 or QuickTime file');
    }
    tops.push(b);
    if (b.type === 'moof') {
      fragmented = true;
      break;
    }
    p = b.end;
  }
  const moovs = tops.filter((t) => t.type === 'moov');
  if (moovs.length !== 1) throw bad('no single moov box');
  if (trailing) notes.push('bytes after the last box were not read');
  if (fragmented) notes.push('fragmented: moov cleaned, moof boxes not walked');

  // 2. Top-level tag boxes become free boxes (headers only: no body is read).
  for (const t of tops) {
    let tag = TAG_BOXES.has(t.type);
    if (!tag && t.type === 'uuid') {
      const id = await source.read(t.body, Math.min(t.end, t.body + 16));
      tag = id.equals(XMP_UUID);
    }
    if (!tag) continue;
    removed.push(`top/${t.type}`);
    patches.push({
      offset: t.start + 4,
      length: 4,
      bytes: Buffer.from('free', 'latin1'),
    });
    if (t.end > t.body)
      patches.push({ offset: t.body, length: t.end - t.body, bytes: null });
  }

  // 3. moov: read once, change a copy, keep the differences.
  const moov = moovs[0];
  if (moov.end - moov.start > MAX_MOOV) throw bad('moov too big');
  const original = await source.read(moov.start, moov.end);
  if (original.length !== moov.end - moov.start) throw bad('moov cut short');
  const m = Buffer.from(original);
  const top: Box = {
    type: 'moov',
    start: 0,
    end: m.length,
    body: moov.body - moov.start,
  };

  const moovKids = kids(m, top);
  if (moovKids.some((k) => k.type === 'mvex')) fragmented = true;
  const mdats = tops.filter((t) => t.type === 'mdat');

  const tag = (b: Box, where: string): boolean => {
    if (TAG_BOXES.has(b.type) || isXmpUuid(m, b)) {
      freeify(m, b);
      removed.push(`${where}/${b.type}`);
      return true;
    }
    if (b.type === 'free' || b.type === 'skip') {
      m.fill(0, b.body, b.end);
      return true;
    }
    return false;
  };

  for (const k of moovKids) {
    if (tag(k, 'moov')) continue;
    if (k.type === 'mvhd') zeroTimes(m, k);
    else if (k.type === 'trak') cleanTrak(k);
  }

  function cleanTrak(trak: Box): void {
    const parts = kids(m, trak);
    const mdia = parts.find((x) => x.type === 'mdia');
    const mdiaParts = mdia ? kids(m, mdia) : [];
    const hdlr = mdiaParts.find((x) => x.type === 'hdlr');
    const handler =
      hdlr && hdlr.body + 12 <= hdlr.end
        ? m.toString('latin1', hdlr.body + 8, hdlr.body + 12)
        : '';
    if (METADATA_HANDLERS.has(handler)) {
      if (fragmented) {
        notes.push(`${handler} track left: file is fragmented`);
      } else {
        const runs = sampleRuns(trak, parts, mdiaParts);
        if (
          runs &&
          runs.every((r) =>
            mdats.some(
              (d) => r.offset >= d.body && r.offset + r.length <= d.end,
            ),
          )
        ) {
          for (const r of runs)
            patches.push({ offset: r.offset, length: r.length, bytes: null });
          freeify(m, trak);
          removed.push(`trak/${handler}(${runs.length} runs)`);
          return;
        }
        notes.push(`${handler} track left: its samples could not be placed`);
      }
    }
    for (const x of parts) {
      if (tag(x, 'trak')) continue;
      if (x.type === 'tkhd') zeroTimes(m, x);
      else if (x.type === 'mdia') {
        for (const y of mdiaParts) {
          if (tag(y, 'mdia')) continue;
          if (y.type === 'mdhd') zeroTimes(m, y);
        }
      }
    }
  }

  /** Where a track's samples sit in the file, one run per chunk; null when the tables do not say. */
  function sampleRuns(
    _trak: Box,
    _parts: Box[],
    mdiaParts: Box[],
  ): { offset: number; length: number }[] | null {
    try {
      const minf = mdiaParts.find((x) => x.type === 'minf');
      const stbl = minf && kids(m, minf).find((x) => x.type === 'stbl');
      if (!stbl) return null;
      const t = kids(m, stbl);
      const stsz = t.find((x) => x.type === 'stsz');
      const stsc = t.find((x) => x.type === 'stsc');
      const stco = t.find((x) => x.type === 'stco');
      const co64 = t.find((x) => x.type === 'co64');
      if (!stsz || !stsc || (!stco && !co64)) return null;
      const uniform = m.readUInt32BE(stsz.body + 4);
      const count = m.readUInt32BE(stsz.body + 8);
      if (uniform === 0 && stsz.body + 12 + count * 4 > stsz.end) return null;
      const size = (i: number) =>
        uniform ? uniform : m.readUInt32BE(stsz.body + 12 + i * 4);
      const scRows = m.readUInt32BE(stsc.body + 4);
      if (stsc.body + 8 + scRows * 12 > stsc.end) return null;
      const co = (stco ?? co64)!;
      const chunks = m.readUInt32BE(co.body + 4);
      const w = stco ? 4 : 8;
      if (co.body + 8 + chunks * w > co.end || chunks > MAX_CHUNKS_READ)
        return null;
      const out: { offset: number; length: number }[] = [];
      let sample = 0;
      let row = 0;
      for (let c = 1; c <= chunks; c += 1) {
        while (
          row + 1 < scRows &&
          m.readUInt32BE(stsc.body + 8 + (row + 1) * 12) <= c
        )
          row += 1;
        const per = m.readUInt32BE(stsc.body + 8 + row * 12 + 4);
        let len = 0;
        for (let s = 0; s < per; s += 1) {
          if (sample >= count) return null;
          len += size(sample);
          sample += 1;
        }
        const at = co.body + 8 + (c - 1) * w;
        const offset = stco
          ? m.readUInt32BE(at)
          : m.readUInt32BE(at) * 2 ** 32 + m.readUInt32BE(at + 4);
        if (len > 0) out.push({ offset, length: len });
      }
      return out;
    } catch {
      return null;
    }
  }

  // The differences, as runs (runs closer than 32 bytes are one, carrying the bytes between).
  let i = 0;
  while (i < m.length) {
    if (m[i] === original[i]) {
      i += 1;
      continue;
    }
    let j = i + 1;
    let last = i;
    while (j < m.length && j - last < 32) {
      if (m[j] !== original[j]) last = j;
      j += 1;
    }
    const to = last + 1;
    patches.push({
      offset: moov.start + i,
      length: to - i,
      bytes: Buffer.from(m.subarray(i, to)),
    });
    i = to;
  }

  return {
    kind: 'mp4',
    patches: checkPatches(patches, source.length),
    removed,
    notes,
  };
}
