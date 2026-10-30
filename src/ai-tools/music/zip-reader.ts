import { inflateRawSync } from 'node:zlib';

/**
 * A small, strict ZIP reader for the one archive the Hub opens: the answer of the stem separation route
 * (AITOOLS-12, R-109). Written on `node:zlib` alone (no package, no native code, no `unzip` binary), so there is no
 * library to trust: this file is the reader and these are its limits. A person's song is the input, but the archive is
 * the PROVIDER's answer; it is still treated as hostile.
 *
 * What it refuses (each is a `ZipRefused` with a reason; the job then fails and every point goes back):
 *  - more than `maxEntries` entries, an archive over `maxArchiveBytes`, an entry over `maxEntryBytes`, or all entries
 *    together over `maxTotalBytes` (declared sizes are checked BEFORE anything is inflated, and the inflater itself is
 *    stopped at the declared size, so a lie in the header cannot make it write more);
 *  - a zip bomb: an entry whose declared size is more than deflate can possibly pack (`maxRatio`, about 1,100 to 1), a
 *    packed size of 0 for a non-empty entry, a header that declares less than the data inflates to, or entries whose
 *    data overlap each other (the trick that makes a small file expand to terabytes);
 *  - a path name that is not plain: absolute, with `..`, a backslash, a drive letter, a NUL or any control character,
 *    longer than 255, or repeated. Names are only ever READ here; the Hub never writes a file under a name from the
 *    archive (it stores each stem under its own key);
 *  - anything the reader does not implement: encryption, ZIP64, a method other than stored (0) and deflate (8), a
 *    multi-disk archive;
 *  - a size or a CRC-32 that does not match what the archive declared.
 */
export const ZIP_LIMITS = {
  maxEntries: 12,
  maxEntryBytes: 128 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxArchiveBytes: 128 * 1024 * 1024,
  /**
   * Deflate cannot pack more than about 1,032 to 1, so a header that claims more than this for its packed bytes is a lie
   * and nothing else. It is NOT set lower: a stem of digital silence (a song with no piano, in a six part split) is
   * honestly hundreds to one, and must not fail the job. What bounds the memory a hostile archive can use is
   * `maxTotalBytes`, `maxEntryBytes` and the inflater's own stop at the declared size, not this ratio.
   */
  maxRatio: 1100,
} as const;

export type ZipLimits = { -readonly [K in keyof typeof ZIP_LIMITS]: number };

export type ZipRefusal =
  | 'not_zip'
  | 'too_many_entries'
  | 'too_big'
  | 'bomb'
  | 'unsafe_name'
  | 'unsupported'
  | 'corrupt';

export class ZipRefused extends Error {
  constructor(readonly reason: ZipRefusal) {
    super(`zip refused: ${reason}`);
    this.name = 'ZipRefused';
  }
}

export interface ZipFile {
  /** The path as the archive wrote it. Plain (checked), but never used to name a stored file. */
  name: string;
  data: Buffer;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

let table: Uint32Array | null = null;
/** CRC-32 (IEEE), as the zip format uses. */
export function crc32(buf: Buffer): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++)
    c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** True when the path is plain: relative, no `..`, no backslash, no drive, no control character. */
export function isPlainPath(name: string): boolean {
  if (name.length === 0 || name.length > 255) return false;
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(name)) return false;
  const parts = name.split('/');
  if (parts.some((p, i) => p === '..' || (p === '' && i < parts.length - 1)))
    return false;
  return !parts.some((p) => p === '.');
}

/**
 * Reads every file of the archive (directories are skipped). Throws `ZipRefused`. Pure: it touches no disk and keeps
 * nothing but the returned buffers.
 */
export function readZip(
  archive: Buffer,
  limits: ZipLimits = { ...ZIP_LIMITS },
): ZipFile[] {
  if (archive.length > limits.maxArchiveBytes) throw new ZipRefused('too_big');
  if (archive.length < 22) throw new ZipRefused('not_zip');
  // The end-of-central-directory record is within the last 65,557 bytes.
  let eocd = -1;
  const from = Math.max(0, archive.length - 22 - 0xffff);
  for (let i = archive.length - 22; i >= from; i--) {
    if (archive.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipRefused('not_zip');
  const disk = archive.readUInt16LE(eocd + 4);
  const cdDisk = archive.readUInt16LE(eocd + 6);
  const onDisk = archive.readUInt16LE(eocd + 8);
  const total = archive.readUInt16LE(eocd + 10);
  const cdSize = archive.readUInt32LE(eocd + 12);
  const cdOffset = archive.readUInt32LE(eocd + 16);
  if (disk !== 0 || cdDisk !== 0 || onDisk !== total)
    throw new ZipRefused('unsupported');
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff)
    throw new ZipRefused('unsupported'); // ZIP64
  if (total > limits.maxEntries) throw new ZipRefused('too_many_entries');
  if (cdOffset + cdSize > eocd) throw new ZipRefused('corrupt');

  const seen = new Set<string>();
  const spans: { start: number; end: number }[] = [];
  const files: ZipFile[] = [];
  let declaredTotal = 0;
  let at = cdOffset;
  for (let n = 0; n < total; n++) {
    if (at + 46 > cdOffset + cdSize || archive.readUInt32LE(at) !== CENTRAL)
      throw new ZipRefused('corrupt');
    const flags = archive.readUInt16LE(at + 8);
    const method = archive.readUInt16LE(at + 10);
    const crc = archive.readUInt32LE(at + 16);
    const packed = archive.readUInt32LE(at + 20);
    const size = archive.readUInt32LE(at + 24);
    const nameLen = archive.readUInt16LE(at + 28);
    const extraLen = archive.readUInt16LE(at + 30);
    const commentLen = archive.readUInt16LE(at + 32);
    const localAt = archive.readUInt32LE(at + 42);
    if (at + 46 + nameLen + extraLen + commentLen > cdOffset + cdSize)
      throw new ZipRefused('corrupt');
    const name = archive
      .subarray(at + 46, at + 46 + nameLen)
      .toString(flags & 0x800 ? 'utf8' : 'latin1');
    at += 46 + nameLen + extraLen + commentLen;

    if (!isPlainPath(name)) throw new ZipRefused('unsafe_name');
    if (seen.has(name)) throw new ZipRefused('unsafe_name');
    seen.add(name);
    if (name.endsWith('/')) continue; // a directory: nothing to read
    if (flags & 0x1 || flags & 0x40) throw new ZipRefused('unsupported'); // encrypted
    if (method !== 0 && method !== 8) throw new ZipRefused('unsupported');
    if (packed === 0xffffffff || size === 0xffffffff || localAt === 0xffffffff)
      throw new ZipRefused('unsupported');

    // Declared sizes, before anything is inflated.
    if (size > limits.maxEntryBytes) throw new ZipRefused('too_big');
    declaredTotal += size;
    if (declaredTotal > limits.maxTotalBytes) throw new ZipRefused('too_big');
    if (method === 0 && packed !== size) throw new ZipRefused('corrupt');
    if (method === 8) {
      if (size > 0 && packed === 0) throw new ZipRefused('bomb');
      if (packed > 0 && size / packed > limits.maxRatio)
        throw new ZipRefused('bomb');
    }

    // The local header says where the data begins; it must agree with the central entry.
    if (localAt + 30 > cdOffset || archive.readUInt32LE(localAt) !== LOCAL)
      throw new ZipRefused('corrupt');
    const localName = archive.readUInt16LE(localAt + 26);
    const localExtra = archive.readUInt16LE(localAt + 28);
    const start = localAt + 30 + localName + localExtra;
    const end = start + packed;
    if (start > cdOffset || end > cdOffset) throw new ZipRefused('corrupt');
    spans.push({ start: localAt, end });

    const packedData = archive.subarray(start, end);
    let data: Buffer;
    if (method === 0) data = Buffer.from(packedData);
    else {
      try {
        // Stopped at the declared size: a header that lies cannot make it write more.
        data = inflateRawSync(packedData, { maxOutputLength: size });
      } catch {
        throw new ZipRefused('bomb');
      }
    }
    if (data.length !== size) throw new ZipRefused('corrupt');
    if (crc32(data) !== crc) throw new ZipRefused('corrupt');
    files.push({ name, data });
  }
  // Two entries sharing bytes is how a small archive expands to a huge one.
  spans.sort((a, b) => a.start - b.start);
  for (let i = 1; i < spans.length; i++)
    if (spans[i].start < spans[i - 1].end) throw new ZipRefused('bomb');
  return files;
}
