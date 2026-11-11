import sharp from 'sharp';
import type { ThumbSize } from './thumb-keys';

/**
 * HUB-THUMBS: makes the two small copies of a picture with `sharp` (libvips, its prebuilt linux-x64 binary).
 *
 * Safety, because a person can upload anything the type allowlist lets through:
 * - `limitInputPixels`: a picture of more than 50 megapixels (20000 x 20000, a decompression bomb whose file is
 *   a few kilobytes) is refused from its header, before a pixel is decoded.
 * - `failOn: 'error'`: a truncated or damaged file throws instead of yielding a half picture.
 * - `animated: false` (the default, stated): an animated WebP is read as its first frame only.
 * - The caller caps the file's bytes (`MAX_THUMB_SOURCE_BYTES`) before this runs and the time around it.
 *
 * Metadata: sharp drops ALL metadata (EXIF, GPS, camera, ICC, XMP) from its output unless `keepMetadata` or
 * `withMetadata` is called, and this file calls neither. `.rotate()` with no argument first applies the EXIF
 * orientation to the pixels, so a phone photo taken sideways is not turned on its side once the tag is gone.
 */
export const MAX_THUMB_SOURCE_BYTES = 25 * 1024 * 1024;
/** The most pixels a picture may have (25 megapixels: a 5000 x 5000 photo; phone cameras of 12 to 24 MP pass). */
export const MAX_THUMB_SOURCE_PIXELS = 25_000_000;
/**
 * The most memory, in bytes, the decoded picture may take (HUB-THUMBS round 1). A picture is decoded ONCE, and what it
 * takes is pixels x channels x bytes per sample, doubled for an interlaced PNG (the decoder holds the whole image
 * and a second pass). 120 MB is a 25 MP 8-bit RGB photo (75 MB) or a 15 MP 8-bit RGBA PNG; a 16-bit or interlaced
 * picture of the same size is refused (it gets no copies and uploads as it always did). Measured in
 * make-thumbs memory table of tasks/history/HUB-THUMBS.md.
 */
export const MAX_THUMB_DECODE_BYTES = 120 * 1024 * 1024;
const WEBP_QUALITY = 78;

/** A picture the Hub will not (or cannot) make copies of: the same bytes will fail again. */
export class UnreadablePicture extends Error {}

sharp.cache(false);

/** Bytes the decoded picture takes in memory, from its header. */
export function decodedBytes(m: sharp.Metadata): number {
  const bytesPerSample =
    m.depth === 'ushort' || m.depth === 'short'
      ? 2
      : m.depth === 'float' || m.depth === 'uint' || m.depth === 'int'
        ? 4
        : 1;
  const channels = Math.max(m.channels ?? 4, 1);
  const interlaced = m.format === 'png' && m.isProgressive ? 2 : 1;
  return (
    (m.width ?? 0) * (m.height ?? 0) * channels * bytesPerSample * interlaced
  );
}

export async function makeThumbs(
  input: Buffer,
): Promise<Record<ThumbSize, Buffer>> {
  const open = () =>
    sharp(input, {
      limitInputPixels: MAX_THUMB_SOURCE_PIXELS,
      failOn: 'error',
      animated: false,
      sequentialRead: true,
    });
  try {
    const m = await open().metadata();
    if (!m.width || !m.height)
      throw new UnreadablePicture('the picture has no size');
    if (m.width * m.height > MAX_THUMB_SOURCE_PIXELS)
      throw new UnreadablePicture('the picture has too many pixels');
    if (decodedBytes(m) > MAX_THUMB_DECODE_BYTES)
      throw new UnreadablePicture(
        'the picture would take too much memory to read',
      );
    // Decoded ONCE: the 640 px copy comes from the original, the 96 px copy from the 640 px result.
    const big = await open()
      .rotate()
      .resize({
        width: 640,
        height: 640,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer();
    const small = await sharp(big)
      .resize({
        width: 96,
        height: 96,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer();
    return { 96: small, 640: big };
  } catch (e) {
    if (e instanceof UnreadablePicture) throw e;
    throw new UnreadablePicture(e instanceof Error ? e.message : String(e));
  }
}
