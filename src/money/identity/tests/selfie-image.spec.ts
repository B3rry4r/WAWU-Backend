import { deflateSync } from 'node:zlib';
import {
  FIXTURES,
  fixture,
  htmlBytes,
  jpegComment,
  jpegImage,
  PNG_SIGNATURE,
  pngChunk,
  pngImage,
  selfiePolyglots,
  zipBytes,
} from '../../../../test/fixtures/selfie/selfie-images';
import {
  isSelfieImage,
  SELFIE_IMAGE_MAX_CHARS,
  SELFIE_IMAGE_MIN_BYTES,
} from '../dto/identity-request.dto';
import { crc32, isJpeg, isPng, SELFIE_MAX_SIDE_PX } from '../selfie-image';

/**
 * The selfie's image check (task KYC-02, verifier rounds 1 and 2, defect 3):
 * a JPEG or PNG is walked from its first byte to its last, so a file framed
 * with the right first and last bytes no longer passes whatever sits between.
 * Real images (Pillow-made fixtures, and PNGs of random pixels) pass.
 */

const b64 = (b: Buffer) => b.toString('base64');
const ok = (b: Buffer) => isSelfieImage(b64(b));

const JPEG = fixture('baseline.jpg');
const PNG = fixture('rgb.png');
const JPEG_END = Buffer.from([0xff, 0xd9]);
const zip = zipBytes();
const html = htmlBytes();
const polyglots = selfiePolyglots();

describe('a real JPEG or PNG passes', () => {
  it.each(FIXTURES)('%s (Pillow) passes', (name) => {
    expect(ok(fixture(name))).toBe(true);
  });

  it('PNGs of random pixels, and JPEGs with comment segments, pass', () => {
    for (let i = 0; i < 20; i += 1) {
      expect(ok(pngImage(20 + i, 20 + 2 * i))).toBe(true);
      expect(ok(jpegImage())).toBe(true);
    }
    expect(ok(jpegImage(undefined, 'progressive.jpg'))).toBe(true);
    expect(ok(jpegImage(undefined, 'exif.jpg'))).toBe(true);
  });

  it('accepts 1 KB up to the cap, and nothing larger or smaller', () => {
    const atCap = jpegImage((SELFIE_IMAGE_MAX_CHARS / 4) * 3);
    expect(b64(atCap).length).toBe(SELFIE_IMAGE_MAX_CHARS);
    expect(ok(atCap)).toBe(true);
    expect(isSelfieImage(`${b64(atCap)}AAAA`)).toBe(false);
    expect(ok(jpegImage((SELFIE_IMAGE_MAX_CHARS / 4) * 3 + 3))).toBe(false);
    const small = pngImage(8, 8);
    expect(small.length).toBeLessThan(SELFIE_IMAGE_MIN_BYTES);
    expect(isPng(small)).toBe(true);
    expect(ok(small)).toBe(false);
    expect(isSelfieImage(null)).toBe(false);
    expect(isSelfieImage(12345)).toBe(false);
  });
});

describe('a file that is not a whole JPEG or PNG is refused (defect 3)', () => {
  it.each(polyglots)('%s', (_name, bytes) => {
    expect(bytes.length).toBeGreaterThanOrEqual(SELFIE_IMAGE_MIN_BYTES / 2);
    expect(ok(bytes)).toBe(false);
  });
});

describe('the PNG walk', () => {
  /** The fixture's chunks, as [type, data]. */
  function chunks(png: Buffer): Array<[string, Buffer]> {
    const out: Array<[string, Buffer]> = [];
    let pos = 8;
    while (pos < png.length) {
      const n = png.readUInt32BE(pos);
      out.push([
        png.toString('latin1', pos + 4, pos + 8),
        png.subarray(pos + 8, pos + 8 + n),
      ]);
      pos += 12 + n;
    }
    return out;
  }
  const build = (list: Array<[string, Buffer]>) =>
    Buffer.concat([PNG_SIGNATURE, ...list.map(([t, d]) => pngChunk(t, d))]);
  const parts = chunks(fixture('rgba-text.png'));

  it('rebuilding the fixture chunk by chunk gives a PNG that passes', () => {
    expect(isPng(build(parts))).toBe(true);
    expect(parts.map(([t]) => t)).toEqual(
      expect.arrayContaining(['IHDR', 'IDAT', 'IEND']),
    );
  });

  it('a wrong CRC anywhere is refused', () => {
    const png = fixture('rgba-text.png');
    let pos = 8;
    while (pos < png.length) {
      const n = png.readUInt32BE(pos);
      const bad = Buffer.from(png);
      bad[pos + 8 + n + 3] ^= 0x01;
      expect(isPng(bad)).toBe(false);
      pos += 12 + n;
    }
  });

  it('a chunk length past the end of the file is refused', () => {
    const bad = Buffer.from(PNG);
    bad.writeUInt32BE(PNG.length, 8 + 25);
    expect(isPng(bad)).toBe(false);
  });

  it('IHDR must come first, once; IEND last, empty; at least one IDAT', () => {
    const [ihdr] = parts;
    const rest = parts.slice(1);
    const idat = parts.filter(([t]) => t === 'IDAT');
    const iend = parts[parts.length - 1];
    const middle = parts.slice(1, -1);
    expect(isPng(build(rest))).toBe(false); // no IHDR
    expect(isPng(build([...middle, ihdr, iend]))).toBe(false); // IHDR not first
    expect(isPng(build([ihdr, ihdr, ...rest]))).toBe(false); // two IHDR
    expect(isPng(build([ihdr, ...middle]))).toBe(false); // no IEND
    expect(isPng(build([ihdr, ...middle, ['IEND', Buffer.from([0])]]))).toBe(
      false,
    ); // IEND not empty
    expect(isPng(build([ihdr, ...middle, iend, ['tEXt', html]]))).toBe(false); // after IEND
    expect(
      isPng(build([ihdr, ...middle.filter(([t]) => t !== 'IDAT'), iend])),
    ).toBe(false); // no IDAT
    expect(idat.length).toBeGreaterThan(0);
  });

  it('pixel data that does not inflate to the rows IHDR describes is refused', () => {
    const [ihdr, ...rest] = parts;
    const swap = (data: Buffer) =>
      build([
        ihdr,
        ...rest.filter(([t]) => t !== 'IDAT' && t !== 'IEND'),
        ['IDAT', data],
        ['IEND', Buffer.alloc(0)],
      ]);
    expect(isPng(swap(html))).toBe(false); // not zlib
    expect(isPng(swap(zip))).toBe(false);
    // Real pixel data, but another image's (10 x 10 RGB, not 72 x 96 RGBA).
    const other = chunks(pngImage(10, 10)).find(([t]) => t === 'IDAT')![1];
    expect(isPng(swap(other))).toBe(false);
  });

  it('a chunk inserted with a correct CRC but an unknown critical type is refused', () => {
    const [ihdr, ...rest] = parts;
    expect(isPng(build([ihdr, ['zzZz', html], ...rest]))).toBe(true);
    expect(isPng(build([ihdr, ['ZZZZ', html], ...rest]))).toBe(false);
    expect(isPng(build([ihdr, ['ab1d', html], ...rest]))).toBe(false);
  });

  it('crc32 is the PNG one', () => {
    expect(crc32(Buffer.from('IEND'))).toBe(0xae426082);
  });
});

describe('the JPEG walk', () => {
  /** Where the first scan's data starts in the fixture. */
  function scanStart(jpeg: Buffer): number {
    let pos = 2;
    for (;;) {
      const marker = jpeg[pos + 1];
      const n = jpeg.readUInt16BE(pos + 2);
      pos += 2 + n;
      if (marker === 0xda) return pos;
    }
  }

  it('an FF in a scan followed by anything but 00, D0 to D7 or the final D9 is refused', () => {
    const start = scanStart(JPEG);
    for (const next of [0x01, 0xc0, 0xd8, 0xe1, 0xfe, 0xff]) {
      const bad = Buffer.concat([
        JPEG.subarray(0, start + 10),
        Buffer.from([0xff, next]),
        JPEG.subarray(start + 10),
      ]);
      expect({ next, ok: isJpeg(bad) }).toEqual({ next, ok: false });
    }
    for (const next of [0x00, 0xd0, 0xd7]) {
      // Structurally allowed in a scan (the pixels would be garbage).
      const fine = Buffer.concat([
        JPEG.subarray(0, start + 10),
        Buffer.from([0xff, next]),
        JPEG.subarray(start + 10),
      ]);
      expect(isJpeg(fine)).toBe(true);
    }
    // An end-of-image before the end of the file.
    const early = Buffer.concat([
      JPEG.subarray(0, start + 10),
      JPEG_END,
      JPEG.subarray(start + 10),
    ]);
    expect(isJpeg(early)).toBe(false);
  });

  it('a segment length past the end, or under 2, is refused', () => {
    const long = Buffer.from(JPEG);
    long.writeUInt16BE(0xffff, 4);
    expect(isJpeg(long)).toBe(false);
    const short = Buffer.from(JPEG);
    short.writeUInt16BE(1, 4);
    expect(isJpeg(short)).toBe(false);
  });

  it('no frame header (SOF) before the scan, or no scan at all, is refused', () => {
    const start = scanStart(JPEG);
    // Drop every SOF segment.
    const parts: Buffer[] = [JPEG.subarray(0, 2)];
    let pos = 2;
    while (pos < start) {
      const marker = JPEG[pos + 1];
      const n = JPEG.readUInt16BE(pos + 2);
      if (!(marker >= 0xc0 && marker <= 0xc3)) {
        parts.push(JPEG.subarray(pos, pos + 2 + n));
      }
      pos += 2 + n;
    }
    parts.push(JPEG.subarray(start));
    expect(isJpeg(Buffer.concat(parts))).toBe(false);
    // Headers, then the end, with no scan.
    let headersEnd = 2;
    while (JPEG[headersEnd + 1] !== 0xda) {
      headersEnd += 2 + JPEG.readUInt16BE(headersEnd + 2);
    }
    expect(
      isJpeg(Buffer.concat([JPEG.subarray(0, headersEnd), JPEG_END])),
    ).toBe(false);
  });

  it('a comment segment holding HTML is still a JPEG (comments are part of the format)', () => {
    const withHtml = Buffer.concat([
      JPEG.subarray(0, 2),
      jpegComment(html),
      JPEG.subarray(2),
    ]);
    expect(isJpeg(withHtml)).toBe(true);
  });
});

/**
 * A PNG of zero pixels: `width` x `height`, colour type and bit depth as
 * given, its rows deflated (zeros compress about 1000 to 1, so a large
 * image stays a small file), with `extra` bytes added to (or, negative,
 * taken off) the rows before deflating.
 */
function zeroPng(
  width: number,
  height: number,
  opts: { colourType?: number; bitDepth?: number; extra?: number } = {},
): Buffer {
  const colourType = opts.colourType ?? 2;
  const bitDepth = opts.bitDepth ?? 8;
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colourType as 0 | 2 | 4 | 6];
  const rowBytes = 1 + Math.ceil((width * channels * bitDepth) / 8);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colourType;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk(
      'IDAT',
      deflateSync(Buffer.alloc(rowBytes * height + (opts.extra ?? 0))),
    ),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('pixel data must inflate to exactly the rows IHDR describes (verifier round 3, finding 3)', () => {
  it('the exact rows pass; one byte more or one byte fewer is refused', () => {
    expect(isPng(zeroPng(40, 30))).toBe(true);
    expect(isPng(zeroPng(40, 30, { extra: 1 }))).toBe(false);
    expect(isPng(zeroPng(40, 30, { extra: 1000 }))).toBe(false);
    expect(isPng(zeroPng(40, 30, { extra: -1 }))).toBe(false);
  });

  it('pixel data that would inflate to 256 MB under a 100 x 100 header is refused without inflating it', () => {
    const bomb = zeroPng(100, 100, { extra: 256 * 1024 * 1024 });
    // A small file: zeros deflate about 1000 to 1.
    expect(bomb.length).toBeLessThan(300_000);
    const started = process.hrtime.bigint();
    expect(isPng(bomb)).toBe(false);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    // Stopping at the rows' size takes about a millisecond; inflating all
    // 256 MB takes hundreds.
    expect(ms).toBeLessThan(50);
  });
});

describe('a selfie is at most SELFIE_MAX_SIDE_PX on each side (verifier round 3, finding 2)', () => {
  it('the cap is 2,048 pixels', () => {
    expect(SELFIE_MAX_SIDE_PX).toBe(2048);
  });

  it('a PNG up to the cap passes; one pixel wider or taller is refused before its pixels are inflated', () => {
    expect(isPng(zeroPng(SELFIE_MAX_SIDE_PX, 2))).toBe(true);
    expect(isPng(zeroPng(2, SELFIE_MAX_SIDE_PX))).toBe(true);
    expect(isPng(zeroPng(SELFIE_MAX_SIDE_PX + 1, 2))).toBe(false);
    expect(isPng(zeroPng(2, SELFIE_MAX_SIDE_PX + 1))).toBe(false);
    // The worst a selfie can now declare: 2,048 x 2,048 16-bit RGBA (33.5
    // MB of rows) still passes, and stays under the base64 cap as a file.
    const worst = zeroPng(SELFIE_MAX_SIDE_PX, SELFIE_MAX_SIDE_PX, {
      colourType: 6,
      bitDepth: 16,
    });
    expect(isPng(worst)).toBe(true);
    expect(ok(worst)).toBe(true);
  });

  it('the 65 KB PNG declaring 4,000 x 4,190 RGBA (67 MB of rows) is refused, and fast', () => {
    const big = zeroPng(4000, 4190, { colourType: 6 });
    expect(big.length).toBeLessThan((SELFIE_IMAGE_MAX_CHARS / 4) * 3);
    const started = process.hrtime.bigint();
    expect(isPng(big)).toBe(false);
    expect(ok(big)).toBe(false);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    expect(ms).toBeLessThan(20);
  });

  it('a JPEG up to the cap passes; one pixel wider or taller is refused', () => {
    // The frame header's height and width, rewritten in the fixture (the
    // walk reads them; it does not decode the pixels).
    let sof = 2;
    while (!(JPEG[sof + 1] >= 0xc0 && JPEG[sof + 1] <= 0xc2)) {
      sof += 2 + JPEG.readUInt16BE(sof + 2);
    }
    const sized = (height: number, width: number) => {
      const out = Buffer.from(JPEG);
      out.writeUInt16BE(height, sof + 5);
      out.writeUInt16BE(width, sof + 7);
      return out;
    };
    expect(isJpeg(sized(SELFIE_MAX_SIDE_PX, SELFIE_MAX_SIDE_PX))).toBe(true);
    expect(isJpeg(sized(SELFIE_MAX_SIDE_PX + 1, 100))).toBe(false);
    expect(isJpeg(sized(100, SELFIE_MAX_SIDE_PX + 1))).toBe(false);
    expect(isJpeg(sized(65535, 65535))).toBe(false);
  });
});
