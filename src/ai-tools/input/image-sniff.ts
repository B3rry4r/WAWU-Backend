/**
 * What a person's photo for a Studio tool is, found from its first bytes
 * (AITOOLS-08): the signature of PNG, JPEG or WebP and the start of the part
 * that holds the picture's size. A file that is not one of the three, or whose
 * header does not hold a picture, is not a photo. No file is decoded and
 * nothing outside the head is read.
 */
export const IMAGE_SNIFF_HEAD_BYTES = 64 * 1024;

export type SniffedImage = {
  contentType: 'image/png' | 'image/jpeg' | 'image/webp';
  width: number;
  height: number;
};

const MOST_PIXELS_ACROSS = 20_000;

function sized(
  contentType: SniffedImage['contentType'],
  width: number,
  height: number,
): SniffedImage | null {
  return width >= 1 &&
    height >= 1 &&
    width <= MOST_PIXELS_ACROSS &&
    height <= MOST_PIXELS_ACROSS
    ? { contentType, width, height }
    : null;
}

/** PNG: the 8 byte signature, then the IHDR chunk with the width and height. */
function png(head: Buffer): SniffedImage | null {
  if (
    head.length < 24 ||
    head.readUInt32BE(0) !== 0x89504e47 ||
    head.readUInt32BE(4) !== 0x0d0a1a0a ||
    head.toString('latin1', 12, 16) !== 'IHDR'
  )
    return null;
  return sized('image/png', head.readUInt32BE(16), head.readUInt32BE(20));
}

/** JPEG: the start-of-image marker, then segments until a start-of-frame segment names the size. */
function jpeg(head: Buffer): SniffedImage | null {
  if (head.length < 4 || head[0] !== 0xff || head[1] !== 0xd8) return null;
  let at = 2;
  while (at + 4 <= head.length) {
    if (head[at] !== 0xff) return null;
    let marker = head[at + 1];
    // Padding bytes between segments.
    while (marker === 0xff && at + 2 < head.length) {
      at += 1;
      marker = head[at + 1];
    }
    const length = head.readUInt16BE(at + 2);
    const frame =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (frame) {
      if (at + 9 > head.length) return null;
      return sized(
        'image/jpeg',
        head.readUInt16BE(at + 7),
        head.readUInt16BE(at + 5),
      );
    }
    if (length < 2) return null;
    at += 2 + length;
  }
  return null;
}

/** WebP: a RIFF container of type WEBP whose first chunk (VP8, VP8L or VP8X) holds the size. */
function webp(head: Buffer): SniffedImage | null {
  if (
    head.length < 30 ||
    head.toString('latin1', 0, 4) !== 'RIFF' ||
    head.toString('latin1', 8, 12) !== 'WEBP'
  )
    return null;
  const chunk = head.toString('latin1', 12, 16);
  if (chunk === 'VP8 ') {
    if (head[23] !== 0x9d || head[24] !== 0x01 || head[25] !== 0x2a)
      return null;
    return sized(
      'image/webp',
      head.readUInt16LE(26) & 0x3fff,
      head.readUInt16LE(28) & 0x3fff,
    );
  }
  if (chunk === 'VP8L') {
    if (head[20] !== 0x2f) return null;
    const bits = head.readUInt32LE(21);
    return sized(
      'image/webp',
      (bits & 0x3fff) + 1,
      ((bits >> 14) & 0x3fff) + 1,
    );
  }
  if (chunk === 'VP8X') {
    const w = 1 + (head[24] | (head[25] << 8) | (head[26] << 16));
    const h = 1 + (head[27] | (head[28] << 8) | (head[29] << 16));
    return sized('image/webp', w, h);
  }
  return null;
}

/** The picture a file's first bytes describe, or null when it is not a PNG, JPEG or WebP picture. */
export function sniffImage(head: Buffer): SniffedImage | null {
  return png(head) ?? jpeg(head) ?? webp(head);
}
