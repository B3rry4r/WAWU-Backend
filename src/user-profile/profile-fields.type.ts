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
}
