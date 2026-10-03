import { inflateSync } from 'node:zlib';

/**
 * Is this file really a JPEG or a PNG, walked from its first byte to its
 * last (task KYC-02, verifier rounds 1 and 2, defect 3)? Every selfie match
 * is charged, so a file is checked before Fintava is asked. Checking only
 * the first and last bytes let a file framed with the right ends pass
 * whatever sat between (HTML, a ZIP); here every byte belongs to a part of
 * the format.
 *
 * No image library is in the backend's dependencies (no sharp, jimp, pngjs
 * or jpeg-js), so the formats are walked here rather than adding one.
 */

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
/** The most pixel data a PNG may inflate to here (a selfie is far smaller). */
const PNG_MAX_RAW_BYTES = 64 * 1024 * 1024;

/**
 * A PNG, chunk by chunk: the signature; IHDR first (13 bytes, sane values);
 * every chunk's length inside the file and its CRC correct; PLTE before the
 * pixels when the colour type needs one; one run of IDAT chunks whose data
 * inflates to exactly the pixel rows IHDR describes; IEND (empty) last, with
 * nothing after it.
 */
export function isPng(bytes: Buffer): boolean {
  if (bytes.length < PNG_SIGNATURE.length + 12 * 3 + 13) return false;
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
  let pos = 8;
  let header: PngHeader | null = null;
  let palette = false;
  let idatRun: 'none' | 'open' | 'closed' = 'none';
  const idat: Buffer[] = [];
  while (pos + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(pos);
    if (length > 0x7fffffff || pos + 12 + length > bytes.length) return false;
    const type = bytes.toString('latin1', pos + 4, pos + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) return false;
    const data = bytes.subarray(pos + 8, pos + 8 + length);
    const crc = bytes.readUInt32BE(pos + 8 + length);
    if (crc32(bytes.subarray(pos + 4, pos + 8 + length)) !== crc) return false;
    pos += 12 + length;

    if (header === null) {
      if (type !== 'IHDR') return false;
      header = readPngHeader(data);
      if (header === null) return false;
      continue;
    }
    if (idatRun === 'open' && type !== 'IDAT') idatRun = 'closed';
    switch (type) {
      case 'IHDR':
        return false;
      case 'PLTE':
        if (idatRun !== 'none' || palette) return false;
        if (length === 0 || length % 3 !== 0 || length > 256 * 3) return false;
        palette = true;
        break;
      case 'IDAT':
        if (idatRun === 'closed') return false;
        if (header.colourType === 3 && !palette) return false;
        idatRun = 'open';
        idat.push(data);
        break;
      case 'IEND':
        return (
          length === 0 &&
          pos === bytes.length &&
          idatRun !== 'none' &&
          inflatesTo(Buffer.concat(idat), pngRawBytes(header))
        );
      default:
        // Another chunk (text, gamma, EXIF...): its length and CRC were
        // checked above. An unknown critical chunk (upper-case first letter)
        // is not a picture we can read.
        if (type[0] === type[0].toUpperCase()) return false;
    }
  }
  return false;
}

interface PngHeader {
  width: number;
  height: number;
  bitDepth: number;
  colourType: number;
  interlace: number;
}

/** Allowed bit depths for each PNG colour type. */
const PNG_DEPTHS: Record<number, number[]> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};
const PNG_CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function readPngHeader(data: Buffer): PngHeader | null {
  if (data.length !== 13) return null;
  const header = {
    width: data.readUInt32BE(0),
    height: data.readUInt32BE(4),
    bitDepth: data[8],
    colourType: data[9],
    interlace: data[12],
  };
  if (header.width === 0 || header.height === 0) return null;
  if (header.width > 0x7fffffff || header.height > 0x7fffffff) return null;
  if (!PNG_DEPTHS[header.colourType]?.includes(header.bitDepth)) return null;
  if (data[10] !== 0 || data[11] !== 0) return null;
  if (header.interlace !== 0 && header.interlace !== 1) return null;
  return header;
}

/** The size of the filtered pixel rows (Adam7 passes when interlaced). */
function pngRawBytes(h: PngHeader): number {
  const bits = PNG_CHANNELS[h.colourType] * h.bitDepth;
  const rows = (w: number, n: number) =>
    w === 0 || n === 0 ? 0 : n * (1 + Math.ceil((w * bits) / 8));
  if (h.interlace === 0) return rows(h.width, h.height);
  const passes: Array<[number, number, number, number]> = [
    [0, 0, 8, 8],
    [4, 0, 8, 8],
    [0, 4, 4, 8],
    [2, 0, 4, 4],
    [0, 2, 2, 4],
    [1, 0, 2, 2],
    [0, 1, 1, 2],
  ];
  let total = 0;
  for (const [x0, y0, dx, dy] of passes) {
    total += rows(
      Math.ceil((h.width - x0) / dx),
      Math.ceil((h.height - y0) / dy),
    );
  }
  return total;
}

/** True when `data` is one zlib stream inflating to exactly `size` bytes. */
function inflatesTo(data: Buffer, size: number): boolean {
  if (size > PNG_MAX_RAW_BYTES) return false;
  try {
    return inflateSync(data, { maxOutputLength: size + 1 }).length === size;
  } catch {
    return false;
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** The CRC-32 PNG uses (ISO 3309), over `data`. */
export function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Start-of-frame markers: baseline, extended, progressive, lossless, arithmetic. */
const JPEG_SOF = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);
const SOS = 0xda;
const EOI = 0xd9;
/** Marker segments that may sit between the frame's scans (progressive JPEGs). */
const JPEG_BETWEEN_SCANS = new Set([0xc4, 0xcc, 0xdb, 0xdd, 0xfe]);

/**
 * A JPEG, marker by marker: SOI first; each marker segment's length inside
 * the file; a frame header (SOF) before the first scan; each scan header
 * (SOS) well formed. Inside a scan's entropy-coded data an `FF` byte is
 * followed only by `00` (a stuffed byte), `D0` to `D7` (a restart marker),
 * or EOI, which must be the file's last two bytes; a progressive JPEG's
 * scans may be separated by table, restart-interval or comment segments
 * (DHT, DAC, DQT, DRI, COM), walked by their lengths like the rest.
 */
export function isJpeg(bytes: Buffer): boolean {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  let pos = 2;
  let frame = false;
  let scans = 0;
  for (;;) {
    // A marker segment.
    if (pos + 4 > bytes.length || bytes[pos] !== 0xff) return false;
    const marker = bytes[pos + 1];
    const length = bytes.readUInt16BE(pos + 2);
    if (length < 2 || pos + 2 + length > bytes.length) return false;
    const segment = bytes.subarray(pos + 4, pos + 2 + length);
    pos += 2 + length;

    if (JPEG_SOF.has(marker)) {
      if (frame || scans > 0) return false;
      if (!sofIsSane(segment)) return false;
      frame = true;
      continue;
    }
    if (marker === SOS) {
      if (!frame || !sosIsSane(segment)) return false;
      scans += 1;
      // The scan's entropy-coded data, up to the next marker.
      for (;;) {
        if (pos >= bytes.length) return false;
        if (bytes[pos] !== 0xff) {
          pos += 1;
          continue;
        }
        if (pos + 1 >= bytes.length) return false;
        const next = bytes[pos + 1];
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
          pos += 2;
          continue;
        }
        if (next === EOI) return pos + 2 === bytes.length;
        if (JPEG_BETWEEN_SCANS.has(next) || next === SOS) break;
        return false;
      }
      continue;
    }
    if (scans > 0) {
      if (!JPEG_BETWEEN_SCANS.has(marker)) return false;
      continue;
    }
    // Before the first scan: APPn, comments and tables only.
    const header =
      (marker >= 0xe0 && marker <= 0xef) || JPEG_BETWEEN_SCANS.has(marker);
    if (!header) return false;
  }
}

/** SOF: precision, a height and width above 0, 1 to 4 components. */
function sofIsSane(s: Buffer): boolean {
  if (s.length < 6) return false;
  const components = s[5];
  return (
    (s[0] === 8 || s[0] === 12 || s[0] === 16) &&
    s.readUInt16BE(1) > 0 &&
    s.readUInt16BE(3) > 0 &&
    components >= 1 &&
    components <= 4 &&
    s.length === 6 + 3 * components
  );
}

/** SOS: 1 to 4 components, and the length that says. */
function sosIsSane(s: Buffer): boolean {
  if (s.length < 1) return false;
  const components = s[0];
  return components >= 1 && components <= 4 && s.length === 4 + 2 * components;
}
