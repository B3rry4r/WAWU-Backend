import sharp from 'sharp';
import { THUMB_SIZES, type ThumbSize } from './thumb-keys';

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
export const MAX_THUMB_SOURCE_PIXELS = 50_000_000;
const WEBP_QUALITY = 78;

/** A picture the Hub will not (or cannot) make copies of: the same bytes will fail again. */
export class UnreadablePicture extends Error {}

sharp.cache(false);

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
  let width: number | undefined;
  let height: number | undefined;
  try {
    ({ width, height } = await open().metadata());
  } catch (e) {
    throw new UnreadablePicture(e instanceof Error ? e.message : String(e));
  }
  if (!width || !height) throw new UnreadablePicture('the picture has no size');
  if (width * height > MAX_THUMB_SOURCE_PIXELS)
    throw new UnreadablePicture('the picture has too many pixels');
  try {
    const made = await Promise.all(
      THUMB_SIZES.map((size) =>
        open()
          .rotate()
          .resize({
            width: size,
            height: size,
            fit: 'inside',
            withoutEnlargement: true,
          })
          .webp({ quality: WEBP_QUALITY })
          .toBuffer(),
      ),
    );
    return Object.fromEntries(
      THUMB_SIZES.map((s, i) => [s, made[i]]),
    ) as Record<ThumbSize, Buffer>;
  } catch (e) {
    throw new UnreadablePicture(e instanceof Error ? e.message : String(e));
  }
}
