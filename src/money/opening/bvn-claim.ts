import type { PrismaService } from '../../common/prisma/prisma.service';
import type { WalletReviewStage } from '../money-view.type';

/**
 * Who holds a BVN, when a provider reviews the person (NUV-02 round 2, D1
 * and D4; lead ruling "who holds a BVN").
 *
 * A BVN is held by one WAWU account while that account's opening with it is
 * with the provider (being made, documents still needed, being checked) or
 * once the provider approved it. A rejected, failed or stopped opening
 * releases it at once, so a person who typed someone else's BVN cannot keep
 * its owner out. The claim follows exactly what the provider was told: it
 * moves to a new number only in the step that sends that number.
 *
 * The claim is `FintavaWalletOpening.bvnHash` (the keyed hash, unique). A
 * released opening keeps the hash of the BVN the provider has, in a form no
 * other row can hold and no BVN hashes to:
 * `released:<wawuUserId>:<hash>`. Holding it again is taking the hash back,
 * which the unique index lets only one account do. Fintava's rows are never
 * touched (a Fintava opening keeps its BVN for good).
 */

const RELEASED = 'released:';

/** The stored form of `bvnHash` while nobody holds it. */
export function releasedBvnHash(wawuUserId: string, bvnHash: string): string {
  return isReleasedBvnHash(bvnHash)
    ? bvnHash
    : `${RELEASED}${wawuUserId}:${bvnHash}`;
}

export function isReleasedBvnHash(stored: string): boolean {
  return stored.startsWith(RELEASED);
}

/** The keyed hash a released value was made from (a held one as it is). */
export function heldBvnHash(wawuUserId: string, stored: string): string {
  const prefix = `${RELEASED}${wawuUserId}:`;
  return stored.startsWith(prefix) ? stored.slice(prefix.length) : stored;
}

/** The stages in which an opening holds its BVN. */
export function stageHoldsBvn(stage: WalletReviewStage): boolean {
  return stage !== 'rejected' && stage !== 'stopped';
}

/**
 * `FintavaWalletOpening.failure` of an opening stopped because the BVN the
 * provider reviewed is now held by another account (approved, or checked
 * again after a correction, while another account held the number). Nothing
 * is opened for it; the person is told to contact support.
 */
export const CLAIM_LOST = 'bvn_held_by_another_account';

/** What aligning the claim with a stage did. */
export type ClaimAlignment =
  /** Not a Nuvion opening (none, or Fintava's): nothing to align. */
  | 'none'
  | 'held'
  | 'released'
  /** The BVN is held by another account: the opening is stopped (earlier). */
  | 'stopped'
  /** The BVN is held by another account: this call stopped the opening. */
  | 'stopped_now';

function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { code?: unknown }).code === 'P2002'
  );
}

/**
 * Makes the opening's claim agree with where the review stands: held in
 * every stage but `rejected` and `stopped`. Taking a released claim back
 * can find the number held by another account meanwhile: the opening is then
 * stopped (`stopped`, `CLAIM_LOST`), never left claiming a number it does
 * not hold. Idempotent; safe to call after every state change.
 */
export async function alignClaim(
  prisma: Pick<PrismaService, 'fintavaWalletOpening'>,
  wawuUserId: string,
  stage: WalletReviewStage,
): Promise<ClaimAlignment> {
  const row = await prisma.fintavaWalletOpening.findUnique({
    where: { wawuUserId },
    select: { bvnHash: true, provider: true, state: true, failure: true },
  });
  if (!row || row.provider !== 'nuvion') return 'none';
  if (row.state === 'stopped' && row.failure === CLAIM_LOST) return 'stopped';
  const hold = stageHoldsBvn(stage);
  if (hold === !isReleasedBvnHash(row.bvnHash)) {
    return hold ? 'held' : 'released';
  }
  const next = hold
    ? heldBvnHash(wawuUserId, row.bvnHash)
    : releasedBvnHash(wawuUserId, row.bvnHash);
  try {
    await prisma.fintavaWalletOpening.updateMany({
      where: { wawuUserId, bvnHash: row.bvnHash },
      data: { bvnHash: next },
    });
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    const stopped = await prisma.fintavaWalletOpening.updateMany({
      where: {
        wawuUserId,
        provider: 'nuvion',
        OR: [{ failure: null }, { failure: { not: CLAIM_LOST } }],
      },
      data: { state: 'stopped', failure: CLAIM_LOST },
    });
    return stopped.count === 1 ? 'stopped_now' : 'stopped';
  }
  return hold ? 'held' : 'released';
}
