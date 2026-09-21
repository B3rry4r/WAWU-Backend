/**
 * "Complete your profile" — the percentage in the ring on the profile screen.
 *
 * DERIVED, never stored. It is a function of which fields are filled, so a
 * column holding it would be wrong from the moment somebody edits their bio
 * and would have to be recomputed on every write to stay right. Computing it
 * on read costs nothing: the profile row is already in hand.
 *
 * ── THE FIVE STEPS, AND WHY THESE ─────────────────────────────────────────
 * Each is something the profile header actually RENDERS, so completing one
 * visibly changes the page the person is looking at. A checklist whose items
 * do not show up anywhere is a checklist people stop believing. Interests are
 * deliberately not on it: they steer recommendations, they are worth
 * collecting, but nothing on this screen draws them, so asking for them here
 * would be asking for something with no visible payoff.
 *
 * Five steps means the ring moves in twenties, which is coarse on purpose.
 * A percentage that creeps by 3% per field invites people to grind it rather
 * than to fill in the thing that is missing.
 */

/** What a profile needs, in the order the screen asks for it. */
export const PROFILE_STEPS = [
  'avatar',
  'cover',
  'handle',
  'bio',
  'links',
] as const;

export type ProfileStep = (typeof PROFILE_STEPS)[number];

/** Just the columns completeness looks at. */
export interface ProfileCompletenessInput {
  avatarUrl: string | null;
  coverUrl: string | null;
  handle: string | null;
  bio: string | null;
  websiteUrl: string | null;
  instagramHandle: string | null;
  whatsappHandle: string | null;
  xHandle: string | null;
  tiktokHandle: string | null;
  youtubeUrl: string | null;
  facebookUrl: string | null;
  linkedinUrl: string | null;
}

export interface ProfileCompleteness {
  /** 0, 20, 40, 60, 80 or 100. */
  pct: number;
  /** Which steps are still outstanding, so the client names them rather than guessing. */
  missing: ProfileStep[];
}

/** Blank, whitespace and null are all "not filled in". */
function filled(value: string | null): boolean {
  return Boolean(value && value.trim());
}

export function profileCompleteness(
  profile: ProfileCompletenessInput,
): ProfileCompleteness {
  const done: Record<ProfileStep, boolean> = {
    avatar: filled(profile.avatarUrl),
    cover: filled(profile.coverUrl),
    handle: filled(profile.handle),
    bio: filled(profile.bio),
    // ONE way to be reached is enough. Requiring every network would leave
    // somebody who only uses Instagram permanently short of 100%, which
    // turns the ring into a nag rather than a task.
    links:
      filled(profile.websiteUrl) ||
      filled(profile.instagramHandle) ||
      filled(profile.whatsappHandle) ||
      filled(profile.xHandle) ||
      filled(profile.tiktokHandle) ||
      filled(profile.youtubeUrl) ||
      filled(profile.facebookUrl) ||
      filled(profile.linkedinUrl),
  };

  const missing = PROFILE_STEPS.filter((step) => !done[step]);
  const pct = Math.round(
    ((PROFILE_STEPS.length - missing.length) / PROFILE_STEPS.length) * 100,
  );
  return { pct, missing };
}
