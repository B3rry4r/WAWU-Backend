/**
 * The profile fields the M1, M4, M5, M8, M9 and M33 screens show (ME-05):
 * location, skills, "open to", Threads and the order of the social links,
 * plus "member since".
 *
 * Everything here is public. M33 draws them for a visitor, and no ruling in
 * DECISIONS.md makes any of them private, so another user's profile-fields
 * answer carries what the owner's own answer carries.
 */

/*
  LIMITS. No document gives a length or a count for any of these fields, so
  each is a named, provisional number that the owner may change. They are
  generous on purpose: a limit that refuses somebody's real answer is worse
  than one that is a little loose. The one number that does have a source is
  the location's, which copies the 120 that ProfileExperience.location uses.
*/
/** PROVISIONAL(PROFILE-LOCATION-MAX, owner=YOU, why=no ruling names a limit; 120 copies ProfileExperience.location). Longest location, in characters. */
export const LOCATION_MAX_LENGTH = 120;
/** PROVISIONAL(PROFILE-SKILLS-MAX, owner=YOU, why=no document or ruling gives a limit for this field). Most skills chips on one profile. */
export const SKILLS_MAX_COUNT = 30;
/** PROVISIONAL(PROFILE-SKILL-LENGTH, owner=YOU, why=no document or ruling gives a limit for this field). Longest single skill, in characters. */
export const SKILL_MAX_LENGTH = 40;
/** PROVISIONAL(PROFILE-OPEN-TO-MAX, owner=YOU, why=no document or ruling gives a limit for this field). Most "open to" chips on one profile. */
export const OPEN_TO_MAX_COUNT = 10;
/** PROVISIONAL(PROFILE-OPEN-TO-LENGTH, owner=YOU, why=no document or ruling gives a limit for this field). Longest single "open to" chip, in characters. */
export const OPEN_TO_MAX_LENGTH = 40;
/** PROVISIONAL(PROFILE-THREADS-LENGTH, owner=YOU, why=no ruling names a limit; 50 is what the X and TikTok handles use). Longest Threads handle. */
export const THREADS_HANDLE_MAX_LENGTH = 50;

/**
 * The platforms M9 lets a person order. These are the keys `socialOrder`
 * carries, first to last. WhatsApp is not on M9 and has no place in the order.
 */
export const SOCIAL_PLATFORMS = [
  'instagram',
  'tiktok',
  'youtube',
  'x',
  'threads',
  'linkedin',
  'facebook',
] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

/** The keys the order may contain, one each, so its length is capped by the list. */
export const SOCIAL_ORDER_MAX_COUNT = SOCIAL_PLATFORMS.length;

/**
 * A list of chips as stored: each trimmed, empty ones dropped, and a repeat
 * (ignoring case) removed so "Editing" and "editing" are not two chips. The
 * first spelling wins and the person's order is kept.
 */
export function normaliseChips(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/** Free text as stored: trimmed, and an empty answer clears the field. */
export function normaliseText(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed || null;
}

/**
 * The profile's `createdAt` as the "member since" date the screens show,
 * ISO 8601. Null when there is no profile yet.
 */
export function memberSinceOf(
  createdAt: Date | null | undefined,
): string | null {
  return createdAt ? createdAt.toISOString() : null;
}
