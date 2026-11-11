/**
 * HUB-THUMBS: which pictures get small copies, and where the copies live.
 *
 * ONLY pictures that are already public are copied. A 640 px copy of a paid picture would give the paid
 * picture away, so the list below is a closed list of key families, and `content/full` (the paid file),
 * every chat folder, identity documents and every other folder are not on it.
 *
 *   avatars/<owner>/<file>          a profile picture: shown to everyone on every card.
 *   profile/cover/<owner>/<file>    the wide image behind a profile header: shown to everyone.
 *   content/cover/<owner>/<file>    a piece's cover (R-114): "public like the preview" (the upload folder says so).
 *   content/preview/<owner>/<file>  the preview asset: what a buyer-to-be sees before paying (R-118: for a
 *                                   picture it is already the creator's own 640 px copy). A preview that is
 *                                   a PDF, a video or audio is not a picture and is never copied.
 *
 * Ad artwork (`ads/artwork`) is public too but is not copied: it has no owner folder and no StorageObject row,
 * so the account purge could not find its copies and nothing could say a copy exists. See the task report.
 *
 * A copy sits beside its original, under the SAME `<family>/<owner>/` prefix:
 *   avatars/<owner>/<uuid>.jpg  ->  avatars/<owner>/<uuid>.t96.webp  and  avatars/<owner>/<uuid>.t640.webp
 * and has a `StorageObject` row of the owner whose `folder` is `thumbs` (so it is never counted in the
 * person's storage allowance, which sums content folders only) and whose key is under the family prefix (so
 * the account purge, which removes every row of the person, finds it).
 */
export const THUMB_SOURCE_FAMILIES = [
  'avatars',
  'profile/cover',
  'content/cover',
  'content/preview',
] as const;

/** The long side, in pixels, of each copy. */
export const THUMB_SIZES = [96, 640] as const;
export type ThumbSize = (typeof THUMB_SIZES)[number];

/** The `StorageObject.folder` of a copy. Not an upload folder, not counted against anyone. */
export const THUMB_ROW_FOLDER = 'thumbs';

/** The only picture types a copy is made from (the types the upload folders take). */
const PICTURE_EXT = /\.(?:jpe?g|png|webp)$/i;
const IS_THUMB_KEY = /\.t(?:96|640)\.webp$/i;
const SEGMENT = /^[A-Za-z0-9._~-]+$/;

/** True for `<family>/<owner>/<file>` with a family on the public list and a picture extension. */
export function thumbSourceOk(key: string): boolean {
  if (typeof key !== 'string' || IS_THUMB_KEY.test(key)) return false;
  if (!PICTURE_EXT.test(key)) return false;
  for (const family of THUMB_SOURCE_FAMILIES) {
    const prefix = `${family}/`;
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length).split('/');
    return (
      rest.length === 2 &&
      rest.every((s) => SEGMENT.test(s) && !/^\.+$/.test(s))
    );
  }
  return false;
}

/** The person a source key belongs to (its second-last segment), or null. */
export function thumbOwnerOf(key: string): string | null {
  if (!thumbSourceOk(key)) return null;
  const parts = key.split('/');
  return parts[parts.length - 2];
}

/** The key of the copy of `key` at `size`, beside it. */
export function thumbKey(key: string, size: ThumbSize): string {
  return key.replace(/\.[^./]+$/, `.t${size}.webp`);
}

/** Both copies' keys (empty for a key that is not a copyable picture). */
export function thumbKeysOf(key: string): string[] {
  return thumbSourceOk(key) ? THUMB_SIZES.map((s) => thumbKey(key, s)) : [];
}
