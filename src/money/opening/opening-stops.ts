/**
 * Why an opening stopped for review because Fintava's customer for the
 * phone is not shown to be this person (task MONEY-12, round 2, D1): its
 * BVN differs from the checked one, or its record carries none. Nothing is
 * adopted or created; the person is answered
 * `409 phone_held_by_other_identity`, `GET /money/wallet` reads `not_open`
 * and the balance `wallet_not_open`. Only a review clears it (BACKEND_GAPS
 * G-37).
 */
export const IDENTITY_STOPS = [
  'phone_held_by_other_identity',
  'phone_holder_bvn_unreadable',
] as const;
export type IdentityStop = (typeof IDENTITY_STOPS)[number];

/** An opening stopped because the phone's Fintava customer is not this person. */
export function stoppedOnIdentity(
  row: { state: string; failure: string | null } | null,
): boolean {
  return (
    row !== null &&
    row.state === 'conflict' &&
    (IDENTITY_STOPS as readonly string[]).includes(row.failure ?? '')
  );
}
