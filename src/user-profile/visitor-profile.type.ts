import type { CreatorProfile } from '../common/types';
import type { ProfileFieldsView } from './profile-fields.type';

/** One live professional listing of the person being visited: what the Services tab opens (`GET /professionals/directory/:id`). */
export interface VisitorListingView {
  /** The listing's id, as the professional's own page takes it. */
  id: string;
  /** The person's own headline for the listing; empty when they wrote none. */
  headline: string;
  /** The field the listing is in (a category key). */
  category: string;
}

/**
 * GET /users/:wawuId/visitor-profile (ME-02): everything M5, M6 and M33 draw
 * about somebody else, in one answer, so the screen is never half drawn.
 *
 * `profile` is exactly what `GET /users/:wawuId/public-profile` answers and
 * `fields` exactly what `GET /users/:wawuId/profile-fields` answers (this
 * route calls the same code), so the two cannot disagree. What the two routes
 * lack: the person's name (it lives in WAWU ID), whether the caller follows
 * them, and their live professional listings.
 *
 * It answers 404 for the same people the public profile does: unknown,
 * blocked either way, deleted, or an account with no public creator profile.
 */
export interface VisitorProfileView {
  /** First and last name from WAWU ID; null when WAWU ID has none (the screen then shows the handle). */
  name: string | null;
  /** The caller is looking at their own profile. */
  own: boolean;
  /** The caller follows this person. */
  following: boolean;
  profile: CreatorProfile;
  fields: ProfileFieldsView;
  /** Approved listings the person has not hidden, newest approval first. */
  listings: VisitorListingView[];
}
