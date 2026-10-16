/**
 * What a claim told its claimer, kept on the registration row (JOIN-03 round
 * 2, `WaitlistRegistration.claimResult`). The same account repeating the same
 * code is answered from it, so an answer lost on the way to the phone can be
 * replayed and the person sees their plan instead of "already claimed".
 *
 * It holds the offer's name, the days, whether they were added to a running
 * plan and the bonus points: nothing about anybody. The person's tier is not
 * stored here; a replay reads it fresh, exactly as `GET /me/tier` answers.
 */
export type StoredClaimResult = {
  offerName: string;
  days: number;
  extended: boolean;
  pointsGranted: number;
  /** ISO 8601, or null when no points were added. */
  pointsExpireAt: string | null;
};

/** The stored answer, or null when the column is empty or is not one this code wrote. */
export function readStoredClaimResult(
  value: unknown,
): StoredClaimResult | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.offerName !== 'string' ||
    !Number.isSafeInteger(v.days) ||
    typeof v.extended !== 'boolean' ||
    !Number.isSafeInteger(v.pointsGranted) ||
    !(v.pointsExpireAt === null || typeof v.pointsExpireAt === 'string')
  )
    return null;
  return {
    offerName: v.offerName,
    days: v.days as number,
    extended: v.extended,
    pointsGranted: v.pointsGranted as number,
    pointsExpireAt: v.pointsExpireAt,
  };
}
