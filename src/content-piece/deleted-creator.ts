/**
 * Who a content piece belongs to once its creator's account is deleted
 * (SETTINGS-06 round 7, owner ruling 16 Oct 2026): buyers keep what they paid
 * for. The purge does not delete a piece that has a completed purchase. It
 * hides it from everything public (status `removed`, as ever), takes the
 * creator's id off it (this value in its place), and leaves it readable to the
 * people who bought it. A `removed` piece owned by this value is the only
 * removed piece a buyer can still open; any other removed piece is gone for
 * everyone.
 */
export const DELETED_CREATOR_ID = 'deleted-account';

/** What a buyer reads where the creator's name was. No em-dash. */
export const DELETED_CREATOR_NAME = 'Deleted account';
