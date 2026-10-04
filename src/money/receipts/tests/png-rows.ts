import { inflateSync } from 'node:zlib';

/** A PNG this repo wrote (8-bit RGBA, filter 0 on every row), read back row by row. */
export function PNG(png: Buffer): {
  width: number;
  height: number;
  rows: (from: number, to: number) => Buffer;
} {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const idat: Buffer[] = [];
  for (let at = 8; at < png.length;) {
    const len = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    if (type === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4 + 1;
  return {
    width,
    height,
    rows: (from, to) => raw.subarray(from * stride, to * stride),
  };
}
