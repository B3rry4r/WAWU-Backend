/**
 * The picture on a sponsored card, uploaded by the WAWU team from the
 * dashboard (ADS-LINK, owner 26 Oct 2026: "if you're uploading on the
 * dashboard"). Before this the dashboard could only be given a typed https
 * link; the typed link still works.
 *
 * Only an admin writes here (`POST /admin/ads/artwork`), only the Hub reads
 * the bytes, and the file is never creator content: it is not counted against
 * anyone's storage and has no StorageObject row. The object key is
 * `ads/artwork/<uuid>.<ext>`; the stored `artworkUrl` is the bucket address of
 * that key with no signature, and serving signs it afresh each time
 * (`StorageService.freshUrlFor`), so the picture never goes dead after a week.
 */

/** The folder the pictures go in. Listed in KEY_FOLDERS so a stored link is recognised and re-signed. */
export const AD_ARTWORK_FOLDER = 'ads/artwork';

/** JPEG, PNG or WebP, the only picture types the dashboard offers. */
export const AD_ARTWORK_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/**
 * The most bytes one picture may be: a 1920 x 1080 photo is a few hundred
 * kilobytes, and the biggest shape drawn (1080 x 2340) fits well inside this.
 * Larger is refused with 413 so the team compresses it before it reaches a
 * phone on mobile data.
 */
export const AD_ARTWORK_MAX_BYTES = 5 * 1024 * 1024;

/** `ads/artwork/<uuid>.<ext>`, the only key shape the Hub issues here. */
export const AD_ARTWORK_KEY =
  /^ads\/artwork\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:jpg|png|webp)$/;

/**
 * What kind of picture these bytes are, from the first bytes of the file, or
 * null when they are none of the three. The type the browser declared is
 * accepted only when it is the same kind, so a page cannot be stored under a
 * picture's name.
 */
export function sniffAdArtwork(
  bytes: Buffer,
): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}
