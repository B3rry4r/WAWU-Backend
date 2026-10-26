/**
 * Where a person put their profile picture or cover inside its frame (R-96).
 *
 * The position travels INSIDE the picture's link, as a fragment after `#`:
 *
 *   https://bucket/avatars/<id>/<uuid>.jpg?X-Amz-...#wmt-pos=0.5200,0.4100,1.8,1.3333
 *
 * The four numbers are the focal point (`x` and `y`, 0 to 1, the point of the
 * photo that sits at the middle of the frame), the zoom (1 is the photo
 * filling the frame, 4 is four times that) and the photo's own `ratio` (width
 * over height), so every screen can place it with no second read.
 *
 * WHY A FRAGMENT AND NOT A FIELD. `UserProfile.avatarUrl` and `coverUrl` are
 * read by about thirty responses (comments, chat, direct messages, cards,
 * search, events, money parties). A position held in a column of its own would
 * be thirty new fields on thirty live responses, and every client would have
 * to carry them beside the link. A fragment is never sent to a storage host,
 * browsers and image loaders ignore it, so the web keeps drawing the photo
 * centred, exactly as before, until it reads the fragment too. A profile that
 * never positioned a photo has no fragment, so every response is byte for
 * byte what it was.
 *
 * Only a link this module wrote is touched. Any other `#` is left alone.
 */

/** The fragment's name: `#wmt-pos=...`. */
export const PHOTO_POSITION_NAME = 'wmt-pos';

/** Zoom runs from the photo filling the frame (1) to four times that. */
export const PHOTO_ZOOM_MIN = 1;
export const PHOTO_ZOOM_MAX = 4;
/**
 * The widest and the tallest photo shape a position is kept for: 1 wide to 5 tall, and 5 wide to 1 tall. The app draws the whole
 * photo at the size its shape and zoom give, so a shape of 0.05 at zoom 4 made an avatar element twenty times its height. Past
 * these a photo is drawn centred, as before. The Hub cannot check the shape against the photo (it holds only the link), so it
 * keeps the range small; the app also ignores a shape that differs from the photo it loaded.
 */
export const PHOTO_RATIO_MIN = 0.2;
export const PHOTO_RATIO_MAX = 5;

export interface PhotoPosition {
  x: number;
  y: number;
  zoom: number;
  ratio: number;
}

const PREFIX = `${PHOTO_POSITION_NAME}=`;
const NUMBER = '(\\d+(?:\\.\\d+)?)';
const GRAMMAR = new RegExp(
  `^${PREFIX}${NUMBER},${NUMBER},${NUMBER},${NUMBER}$`,
);

/** A link cut at its first `#`. `fragment` is what follows, or null when there is none. */
export function cutFragment(link: string): {
  base: string;
  fragment: string | null;
} {
  const at = link.indexOf('#');
  if (at === -1) return { base: link, fragment: null };
  return { base: link.slice(0, at), fragment: link.slice(at + 1) };
}

/** True when the link carries a position fragment (well formed or not). */
export function hasPhotoPosition(link: string): boolean {
  const { fragment } = cutFragment(link);
  return fragment !== null && fragment.startsWith(PREFIX);
}

const within = (value: number, min: number, max: number) =>
  Number.isFinite(value) && value >= min && value <= max;

/** The position a fragment (without its `#`) holds, or null when it is not a well formed one in range. */
export function parsePhotoPosition(fragment: string): PhotoPosition | null {
  const match = GRAMMAR.exec(fragment);
  if (!match) return null;
  const [x, y, zoom, ratio] = match.slice(1).map(Number);
  if (!within(x, 0, 1) || !within(y, 0, 1)) return null;
  if (!within(zoom, PHOTO_ZOOM_MIN, PHOTO_ZOOM_MAX)) return null;
  if (!within(ratio, PHOTO_RATIO_MIN, PHOTO_RATIO_MAX)) return null;
  return { x, y, zoom, ratio };
}

/** A number as short as it can be at `digits` places: 0.5 not 0.5000, 2 not 2.000. */
function short(value: number, digits: number): string {
  return String(Number(value.toFixed(digits)));
}

/** The canonical fragment (without its `#`): x and y to 4 places, zoom to 3, ratio to 4. */
export function formatPhotoPosition(position: PhotoPosition): string {
  return `${PREFIX}${short(position.x, 4)},${short(position.y, 4)},${short(position.zoom, 3)},${short(position.ratio, 4)}`;
}

/** `base` with the position as its fragment; `base` unchanged when there is none. */
export function withPhotoPosition(
  base: string,
  position: PhotoPosition | null,
): string {
  return position ? `${base}#${formatPhotoPosition(position)}` : base;
}

/**
 * The link as it should be stored: a well formed position is kept in its canonical form;
 * `null` when the link carries one that is malformed or out of range (the caller answers 400).
 * A link with no position, or with a `#` that is not ours, is returned untouched.
 */
export function cleanPhotoLink(link: string): string | null {
  const { base, fragment } = cutFragment(link);
  if (fragment === null || !fragment.startsWith(PREFIX)) return link;
  const position = parsePhotoPosition(fragment);
  return position ? withPhotoPosition(base, position) : null;
}

/**
 * Signing a stored link again gives a new link with no fragment. This puts the stored position
 * (if it has one) back on the fresh link, so a re-signed picture keeps where it was placed.
 */
export function keepPhotoPosition(stored: string, fresh: string): string {
  const { fragment } = cutFragment(stored);
  if (fragment === null || !fragment.startsWith(PREFIX)) return fresh;
  return `${cutFragment(fresh).base}#${fragment}`;
}
