/**
 * INBOX-01. How a community's share link is spelled.
 *
 * The slug is made once from the room's name: accents dropped, lower case,
 * every run of anything that is not a letter or a digit becomes one `-`.
 * "Aba Tailors' Circle" becomes `aba-tailors-circle`. A name with nothing
 * usable in it (all emoji, say) becomes `room`. A second room with the same
 * name gets `-2`, then `-3`, and so on.
 */

/** Longest base a name can produce, before any `-2` suffix. */
export const SLUG_BASE_MAX = 48;

/** Longest slug the resolve route will look up. */
export const SLUG_MAX = 64;

/** Lower-case letters and digits in groups joined by single hyphens. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function slugBase(name: string): string {
  const words = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const cut = words.slice(0, SLUG_BASE_MAX).replace(/-+$/, '');
  return cut || 'room';
}

/** The link as people see and share it. */
export function shareLink(slug: string): string {
  return `wawu/c/${slug}`;
}

/**
 * What someone typed or tapped, as the slug it should match: trimmed and
 * lower-cased, so `wawu/c/Aba-Tailors` still opens the room. Null when it
 * cannot be a slug at all.
 */
export function normaliseSlug(raw: string): string | null {
  const slug = raw.trim().toLowerCase();
  if (slug.length === 0 || slug.length > SLUG_MAX) return null;
  return SLUG_PATTERN.test(slug) ? slug : null;
}
