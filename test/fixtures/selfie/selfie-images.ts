import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { crc32 } from '../../../src/money/identity/selfie-image';

/**
 * Real images for the selfie tests (task KYC-02). The backend walks a
 * selfie's structure (src/money/identity/selfie-image.ts), so a test image
 * must be one an encoder wrote, never random bytes between a valid start
 * and end. The JPEGs and PNGs here were drawn by Pillow from shapes
 * (make_fixtures.py), never a photo of anyone; the PNGs built below are
 * real PNGs of random pixels.
 */

export type Fixture =
  | 'baseline.jpg'
  | 'exif.jpg'
  | 'progressive.jpg'
  | 'gray.jpg'
  | 'rgb.png'
  | 'rgba-text.png'
  | 'interlaced.png';

export const FIXTURES: readonly Fixture[] = [
  'baseline.jpg',
  'exif.jpg',
  'progressive.jpg',
  'gray.jpg',
  'rgb.png',
  'rgba-text.png',
  'interlaced.png',
];

export function fixture(name: Fixture): Buffer {
  return readFileSync(join(__dirname, name));
}

/** A JPEG comment segment (COM, `FF FE`) holding `text` (at most 65,533 bytes). */
export function jpegComment(text: Buffer): Buffer {
  const head = Buffer.from([0xff, 0xfe, 0, 0]);
  head.writeUInt16BE(text.length + 2, 2);
  return Buffer.concat([head, text]);
}

/**
 * A valid JPEG: a Pillow JPEG with comment segments put in right after its
 * start (SOI). The first carries a random id, so every image differs from
 * its first bytes on (the leak scans look for each); more are added to reach
 * `size` bytes exactly, when given.
 */
export function jpegImage(
  size?: number,
  base: Fixture = 'baseline.jpg',
): Buffer {
  const jpeg = fixture(base);
  const id = jpegComment(Buffer.from(randomBytes(12).toString('hex')));
  const parts = [jpeg.subarray(0, 2), id];
  let length = jpeg.length + id.length;
  if (size !== undefined) {
    let missing = size - length;
    if (missing !== 0 && missing < 4) throw new Error('size too close');
    while (missing > 0) {
      // Never leave 1 to 3 bytes over: a segment needs 4.
      let take = Math.min(missing, 65_537);
      if (missing - take > 0 && missing - take < 4) take -= 4;
      parts.push(jpegComment(Buffer.alloc(take - 4, 0x41)));
      missing -= take;
      length += take;
    }
  }
  parts.push(jpeg.subarray(2));
  return Buffer.concat(parts);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

export const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** A real PNG of random RGB pixels, `width` x `height` (unique every time). */
export function pngImage(width = 32, height = 32): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    rows.push(Buffer.from([0]), randomBytes(width * 3));
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export { pngChunk };

/** A ZIP's local header, random bytes, and its end record. */
export function zipBytes(): Buffer {
  return Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    randomBytes(1500),
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    Buffer.alloc(18),
  ]);
}

export function htmlBytes(): Buffer {
  return Buffer.from(
    `<html><body>${'<p>not a photo</p>'.repeat(100)}</body></html>`,
  );
}

/**
 * Every file the round-2 verifier sent (its `vk23/img` set, rebuilt here
 * from the fixtures), round 1's list, and more framings. None is a whole
 * JPEG or PNG; each must be refused before Fintava is asked.
 */
export function selfiePolyglots(): Array<[string, Buffer]> {
  const JPEG = fixture('baseline.jpg');
  const PNG = fixture('rgb.png');
  const JPEG_START = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  const JPEG_END = Buffer.from([0xff, 0xd9]);
  const IEND = pngChunk('IEND', Buffer.alloc(0));
  const IHDR = PNG.subarray(8, 33);
  const zip = zipBytes();
  const html = htmlBytes();
  const realJpegPlusZip = Buffer.concat([JPEG, zip]);
  return [
    // Round 2's framed files: the right first and last bytes, anything between.
    ['JPEG start, HTML, JPEG end', Buffer.concat([JPEG_START, html, JPEG_END])],
    ['JPEG start, a ZIP, JPEG end', Buffer.concat([JPEG_START, zip, JPEG_END])],
    [
      'a real JPEG, a ZIP, then FF D9',
      Buffer.concat([realJpegPlusZip, JPEG_END]),
    ],
    [
      'PNG signature and IHDR, HTML, an IEND chunk',
      Buffer.concat([PNG_SIGNATURE, IHDR, html, IEND]),
    ],
    ['a real PNG, a ZIP, then a second IEND', Buffer.concat([PNG, zip, IEND])],
    // Round 1's and round 2's other files.
    ['JPEG start, then HTML', Buffer.concat([JPEG_START, html])],
    ['JPEG start, then a ZIP', Buffer.concat([JPEG_START, zip])],
    [
      'JPEG start, then random bytes',
      Buffer.concat([JPEG_START, randomBytes(3000)]),
    ],
    [
      'JPEG start, random bytes, JPEG end',
      Buffer.concat([JPEG_START, randomBytes(3000), JPEG_END]),
    ],
    ['a JPEG with a ZIP appended', realJpegPlusZip],
    ['a JPEG with HTML appended', Buffer.concat([JPEG, html])],
    [
      'a JPEG with one byte after its end',
      Buffer.concat([JPEG, Buffer.from([0x00])]),
    ],
    ['a ZIP, then a JPEG', Buffer.concat([zip, JPEG])],
    ['a JPEG cut in half', JPEG.subarray(0, JPEG.length >> 1)],
    ['a JPEG cut by 1 byte', JPEG.subarray(0, JPEG.length - 1)],
    ['a JPEG cut by 2 bytes', JPEG.subarray(0, JPEG.length - 2)],
    [
      'a JPEG end without its start',
      Buffer.concat([randomBytes(3000), JPEG_END]),
    ],
    [
      'PNG signature on a JPEG body',
      Buffer.concat([PNG_SIGNATURE, JPEG.subarray(3)]),
    ],
    [
      'PNG signature and IEND, no IHDR first',
      Buffer.concat([PNG_SIGNATURE, randomBytes(3000), IEND]),
    ],
    [
      'PNG signature and IHDR, no IEND',
      Buffer.concat([PNG_SIGNATURE, IHDR, randomBytes(3000)]),
    ],
    ['PNG signature, then HTML', Buffer.concat([PNG_SIGNATURE, html])],
    ['a PNG with a ZIP appended', Buffer.concat([PNG, zip])],
    ['a PNG cut in half', PNG.subarray(0, PNG.length >> 1)],
    ['a PNG whose IEND is cut short', PNG.subarray(0, PNG.length - 1)],
    ['a GIF', Buffer.concat([Buffer.from('GIF89a'), randomBytes(3000)])],
    [
      'a WebP',
      Buffer.concat([
        Buffer.from('RIFF'),
        Buffer.from([0x00, 0x10, 0x00, 0x00]),
        Buffer.from('WEBPVP8 '),
        randomBytes(3000),
      ]),
    ],
  ];
}
