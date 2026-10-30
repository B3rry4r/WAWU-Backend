import { BadRequestException } from '@nestjs/common';
import { COVER_FOLDER, objectKeyFrom } from '../storage/storage.service';

/**
 * CONTENT-COVER (R-114). A piece's optional cover picture is a file the owner uploaded with
 * `POST /uploads/presign` (folder `content/cover`: png, jpeg or webp, at most 5 MB, counted in their storage).
 * A listing names it by that call's `key` (or its `fileUrl`); the Hub stores the KEY, never a link, and each view
 * signs a fresh link on every read.
 */
export const COVER_NOT_USABLE =
  'The cover must be a picture you uploaded for this. Upload it again.';

/** The grammar `presignUpload` writes for a cover: `content/cover/<wawuId>/<uuid>.<jpg|png|webp>`, under THIS person's own prefix. */
function isOwnCoverKey(key: string, wawuId: string): boolean {
  if (key.includes('..') || key.includes('//')) return false;
  const parts = key.split('/');
  return (
    parts.length === 4 &&
    `${parts[0]}/${parts[1]}` === COVER_FOLDER &&
    parts[2] === wawuId &&
    /^[0-9a-f-]{36}\.(jpg|png|webp)$/.test(parts[3])
  );
}

/**
 * What a request's `coverAsset` means: `undefined` (not sent) leaves the cover as it is, `null` takes it off, and a
 * string must be the key (or link) of the caller's own cover upload, else 400. Whether that upload exists, is the
 * person's and was not given up is checked inside the listing's transaction (`ContentPieceService.assertCoverUsable`).
 */
export function coverKeyOf(
  wawuId: string,
  value: string | null | undefined,
): string | null | undefined {
  if (value === undefined || value === null) return value;
  const key = objectKeyFrom(value);
  if (!isOwnCoverKey(key, wawuId)) {
    throw new BadRequestException(COVER_NOT_USABLE);
  }
  return key;
}
