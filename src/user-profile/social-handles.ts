/**
 * TURNS WHAT SOMEBODY TYPES INTO A LINK THAT WORKS.
 *
 * Half these fields demanded a full "https://facebook.com/you" while the other
 * half took a bare handle, on the same form. Nobody knows their LinkedIn URL
 * from memory; everybody knows their handle. So every field now accepts a
 * handle, with or without the leading "@", and this builds the canonical URL.
 *
 * A full URL that someone pastes anyway is left exactly as it is: people do
 * paste them, and rewriting a link they already checked would be worse than
 * accepting it. A vanity domain or a country subdomain therefore survives.
 */

const BASE: Record<string, string> = {
  youtube: 'https://youtube.com/@',
  facebook: 'https://facebook.com/',
  linkedin: 'https://linkedin.com/in/',
};

/** Already a link? Leave it alone. */
function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/**
 * `platform` picks the prefix. Returns null for an empty value so a cleared
 * field stores null rather than a bare prefix pointing at the platform's
 * homepage, which would look like a real profile link and go nowhere.
 */
export function toProfileUrl(
  value: string | null | undefined,
  platform: keyof typeof BASE,
): string | null {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return null;
  if (isUrl(trimmed)) return trimmed;

  // A handle. Strip the "@" people type out of habit, and any leading slash
  // from a half-pasted path, then hang it off the platform's base.
  const handle = trimmed.replace(/^@+/, '').replace(/^\/+/, '');
  if (!handle) return null;
  return BASE[platform] + handle;
}

/**
 * The inverse, for the edit form: show the handle rather than the URL, so
 * somebody editing sees what they typed instead of a link they have to
 * carefully cut a prefix off.
 */
export function toHandle(url: string | null | undefined, platform: keyof typeof BASE): string {
  const value = (url ?? '').trim();
  if (!value) return '';
  const base = BASE[platform];
  if (value.startsWith(base)) return value.slice(base.length);
  return value;
}

/** Handles stored as handles: strip a stray "@" so they are consistent. */
export function normaliseHandle(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim().replace(/^@+/, '');
  return trimmed || null;
}
