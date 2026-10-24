import type { PersonBadgeView } from '../plans/tier-badge/person-badge-view.type';

/**
 * GET and PATCH /users/me/profile-fields, and GET /users/:wawuId/profile-fields
 * (ME-05): the profile fields M1, M4, M5, M8, M9 and M33 show.
 *
 * Every key is always present. A person who has set none of them gets null and
 * empty lists, never a missing key or a 404.
 */
export interface ProfileFieldsView {
  wawuUserId: string;
  /** Free text, "Lagos, Nigeria". */
  location: string | null;
  /**
   * Country of residence, ISO 3166-1 alpha-2 ("NG"), and its English name
   * (GEO-02, R-85). On your own answer it is the country you chose, else the
   * one WAWU ID or your phone gives; on somebody else's it is shown only when
   * they chose it.
   */
  countryCode: string | null;
  countryName: string | null;
  /** Full ISO 3166-2 code ("NG-LA") and the name saved with it ("Lagos"). Only ever set by the person. */
  regionCode: string | null;
  regionName: string | null;
  /** Free text ("Ikeja"). */
  city: string | null;
  /** Skills and expertise chips, in the order the person wrote them. */
  skills: string[];
  /** What the person is open to, as chips, in the order they wrote them. */
  openTo: string[];
  /** Bare handle, no "@". */
  threadsHandle: string | null;
  /**
   * The order the social links show in, first to last, as platform keys
   * (instagram, tiktok, youtube, x, threads, linkedin, facebook). Empty means
   * the app's default order.
   */
  socialOrder: string[];
  /** When the profile began, ISO 8601: "On Who Made This since ...". Null before a profile exists. */
  memberSince: string | null;
  /**
   * The person's tier badge while a tier runs, else null (TIER-07): the pill
   * beside the name on M1 and M5, with the Founding Maker number (VF7a).
   */
  badge: PersonBadgeView | null;
}
