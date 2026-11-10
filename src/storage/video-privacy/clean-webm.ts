import {
  checkPatches,
  Unreadable,
  type CleanPlan,
  type Patch,
  type VideoSource,
} from './types';

/**
 * VIDEO-PRIVACY (R-127): the privacy plan for a WebM (Matroska) file, in place
 * and the same size, like the MP4 plan. Browsers record WebM with no location
 * (the Hub takes it from `MediaRecorder` and from converted files), so this
 * covers a file that came through a converter that copied tags:
 *  - the `Tags` and `Attachments` elements become `Void` elements of the same
 *    total size (zeroed body);
 *  - the `DateUTC` in `Info` is zeroed.
 * Elements are walked by their headers. A segment is read until a cluster of
 * unknown size (a live recording), where the walk stops and says so.
 */
const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_DATE_UTC = 0x4461;
/** Title, MuxingApp and WritingApp: text a person or a device wrote. */
const TEXT_IDS = new Map([
  [0x7ba9, 'Title'],
  [0x4d80, 'MuxingApp'],
  [0x5741, 'WritingApp'],
]);
const MAX_INFO_ELEMENTS = 1000;
const ID_TAGS = 0x1254c367;
const ID_ATTACHMENTS = 0x1941a469;
const ID_CLUSTER = 0x1f43b675;
const MAX_ELEMENTS = 1000;
/** The same planning budget as the MP4 walk: past it the file is left as it is. */
const PLAN_BUDGET_MS = 1500;
const MAX_INFO = 1024 * 1024;

interface El {
  id: number;
  start: number;
  body: number;
  /** null when the size is "unknown". */
  end: number | null;
  idLen: number;
  sizeLen: number;
}

/** Reads an element header from `b` at `at`; null when it does not fit. */
function header(b: Buffer, at: number, base: number, limit: number): El | null {
  if (at >= b.length) return null;
  const first = b[at];
  if (first === 0) throw new Unreadable('bad element id');
  const idLen = Math.clz32(first) - 23;
  if (idLen < 1 || idLen > 4 || at + idLen >= b.length) return null;
  let id = 0;
  for (let i = 0; i < idLen; i += 1) id = id * 256 + b[at + i];
  const s0 = b[at + idLen];
  if (s0 === 0) throw new Unreadable('bad element size');
  const sizeLen = Math.clz32(s0) - 23;
  if (at + idLen + sizeLen > b.length) return null;
  let size = BigInt(s0 & (0xff >> sizeLen));
  let allOnes = (s0 & (0xff >> sizeLen)) === 0xff >> sizeLen;
  for (let i = 1; i < sizeLen; i += 1) {
    const v = b[at + idLen + i];
    size = size * 256n + BigInt(v);
    if (v !== 0xff) allOnes = false;
  }
  const body = base + at + idLen + sizeLen;
  const end = allOnes ? null : body + Number(size);
  if (end !== null && (end > limit || !Number.isSafeInteger(end)))
    throw new Unreadable('element outside its parent');
  return { id, start: base + at, body, end, idLen, sizeLen };
}

/** A Void element filling `total` bytes from `start`: bytes for the header, zeros after. */
function voidOver(el: El & { end: number }): Patch[] {
  const total = el.end - el.start;
  let sLen = el.sizeLen + el.idLen - 1;
  if (sLen > 8) sLen = 8;
  const payload = total - 1 - sLen;
  if (payload < 0 || sLen < 1)
    throw new Unreadable('element too small to void');
  const marked = BigInt(payload) + (1n << BigInt(7 * sLen));
  const head = Buffer.alloc(1 + sLen);
  head[0] = 0xec;
  for (let i = sLen - 1; i >= 0; i -= 1)
    head[1 + i] = Number((marked >> BigInt(8 * (sLen - 1 - i))) & 0xffn);
  const out: Patch[] = [{ offset: el.start, length: head.length, bytes: head }];
  if (payload > 0)
    out.push({ offset: el.start + head.length, length: payload, bytes: null });
  return out;
}

export async function planWebm(source: VideoSource): Promise<CleanPlan> {
  const patches: Patch[] = [];
  const removed: string[] = [];
  const notes: string[] = [];

  const at = async (p: number, limit: number): Promise<El | null> => {
    const buf = await source.read(p, Math.min(source.length, p + 16));
    return header(buf, 0, p, limit);
  };

  const ebml = await at(0, source.length);
  if (!ebml || ebml.id !== ID_EBML || ebml.end === null)
    throw new Unreadable('not a WebM file');
  const seg = await at(ebml.end, source.length);
  if (!seg || seg.id !== ID_SEGMENT) throw new Unreadable('no segment');
  const segEnd = seg.end ?? source.length;

  const started = Date.now();
  let p = seg.body;
  for (let seen = 0; p < segEnd && seen < MAX_ELEMENTS; seen += 1) {
    if (Date.now() - started > PLAN_BUDGET_MS)
      throw new Unreadable('planning took too long');
    const el = await at(p, segEnd);
    if (!el) break;
    if (el.end === null) {
      if (el.id === ID_CLUSTER) {
        notes.push('stopped at a cluster of unknown size');
        break;
      }
      throw new Unreadable('element of unknown size');
    }
    const known = el as El & { end: number };
    if (el.id === ID_TAGS || el.id === ID_ATTACHMENTS) {
      patches.push(...voidOver(known));
      removed.push(el.id === ID_TAGS ? 'Tags' : 'Attachments');
    } else if (el.id === ID_INFO) {
      if (known.end - known.body > MAX_INFO)
        throw new Unreadable('info too big');
      const info = await source.read(known.body, known.end);
      let q = 0;
      for (let n = 0; q < info.length; n += 1) {
        if (n > MAX_INFO_ELEMENTS) throw new Unreadable('too many elements');
        const c = header(info, q, known.body, known.end);
        if (!c || c.end === null) throw new Unreadable('bad info element');
        const name = c.id === ID_DATE_UTC ? 'DateUTC' : TEXT_IDS.get(c.id);
        if (name && c.end > c.body) {
          const cur = info.subarray(c.body - known.body, c.end - known.body);
          if (cur.some((x) => x !== 0)) {
            patches.push({
              offset: c.body,
              length: c.end - c.body,
              bytes: null,
            });
            removed.push(name);
          }
        }
        q = c.end - known.body;
      }
    }
    p = known.end;
  }
  if (p < segEnd && notes.length === 0 && patches.length === 0)
    notes.push('walk stopped before the end of the segment');
  return {
    kind: 'webm',
    patches: checkPatches(patches, source.length),
    removed,
    notes,
  };
}
