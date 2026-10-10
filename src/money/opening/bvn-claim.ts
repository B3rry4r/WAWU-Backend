import type { PrismaService } from '../../common/prisma/prisma.service';
import {
  type EntityStage,
  numbersFailed,
  type ReviewRecord,
  reviewStageOf,
} from './review-stage';

/**
 * Who holds a BVN, when a provider reviews the person (NUV-02 round 2, D1
 * and D4; round 3, N1 to N3; lead rulings "who holds a BVN" and "an
 * unfinished opening's hold expires").
 *
 * A BVN is held by one WAWU account for as long as the provider's entity for
 * that account still carries it in a live state, and it is let go only when
 * that is no longer so:
 *
 * - **held**: the opening is with the provider (being made, documents still
 *   needed, being checked), was approved, or was refused only for its
 *   documents or details (the entity keeps the BVN and the person corrects
 *   the documents); and always once an account is recorded, whatever the
 *   provider later says (a failed or suspended entity with an account keeps
 *   its hold: support decides);
 * - **let go at once**: a refusal that names the identity itself (the BVN or
 *   the NIN refused), and a failed or suspended entity that has no account
 *   (and a create the provider refused, where nothing was made);
 * - **let go by time**: an opening that sits at "documents needed", or was
 *   refused only for its documents, with nothing from the person for
 *   IDENTITY_HOLD_DAYS is marked `expired` (src/money/opening/
 *   identity-hold.ts); support can release one person's hold at once.
 *
 * The claim follows exactly what the provider was told: it moves to a new
 * number only in the step that sends that number.
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

/** The opening state of an opening marked expired (idle too long, or released by support). */
export const EXPIRED_STATE = 'expired';

/** `FintavaWalletOpening.failure` of an expired opening, by cause. */
export const EXPIRED_IDLE = 'hold_expired';
export const EXPIRED_BY_SUPPORT = 'hold_released_by_support';

/** What decides whether an opening still holds its BVN. */
export interface HoldFacts {
  /** The opening's state (`FintavaWalletOpening.state`). */
  state: string;
  /** The entity at the provider is recorded for this person. */
  hasEntity: boolean;
  /** The stage of the provider's review, from what is stored of it. */
  stage: EntityStage;
  /** The review named the BVN or the NIN as what failed. */
  numbersRefused: boolean;
  /** An account is recorded or was requested (or a wallet exists). */
  hasAccount: boolean;
}

/**
 * Whether the opening holds its BVN. Pure: the handler, the opening, the
 * sweep and the specs share it.
 */
export function holdsBvn(f: HoldFacts): boolean {
  if (f.state === EXPIRED_STATE) return false;
  // Nothing was recorded at the provider: only a create in flight (or one
  // whose answer was lost) can still turn into an entity carrying the BVN.
  if (!f.hasEntity) return f.state === 'opening' || f.state === 'unknown';
  switch (f.stage) {
    case 'needs_documents':
    case 'checking':
    case 'approved':
      return true;
    case 'rejected':
      // Only the identity itself refused lets the BVN go; a refusal about
      // the documents or the details leaves the BVN on the entity.
      return f.hasAccount || !f.numbersRefused;
    case 'stopped':
      return f.hasAccount;
  }
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

/** The entity columns a hold is read from (NuvionEntity). */
export const HOLD_ENTITY_SELECT = {
  entityId: true,
  status: true,
  decidedAt: true,
  correctedAt: true,
  bvnStatus: true,
  ninStatus: true,
  documentStatus: true,
  addressProofStatus: true,
  rejectionReasons: true,
  accountId: true,
  accountRequestedAt: true,
  submittedAt: true,
  progressAt: true,
  holdExpiredAt: true,
} as const;

/** One NuvionEntity row as `HOLD_ENTITY_SELECT` reads it. */
export type HoldEntity = ReviewRecord & {
  entityId: string | null;
  accountId: string | null;
  accountRequestedAt: Date | null;
  submittedAt: Date | null;
  progressAt: Date | null;
  holdExpiredAt: Date | null;
};

/** The facts of one opening and its entity, for `holdsBvn`. */
export function holdFactsOf(
  state: string,
  entity: HoldEntity | null,
  hasWallet: boolean,
): HoldFacts {
  return {
    state,
    hasEntity: !!entity?.entityId,
    stage: entity ? reviewStageOf(entity) : 'needs_documents',
    numbersRefused: entity ? numbersFailed(entity) : false,
    hasAccount:
      hasWallet ||
      (entity !== null &&
        (entity.accountId !== null || entity.accountRequestedAt !== null)),
  };
}

type ClaimPrisma = Pick<
  PrismaService,
  'fintavaWalletOpening' | 'nuvionEntity' | 'fintavaWallet'
>;

/**
 * Makes the opening's claim agree with where the review stands (`holdsBvn`):
 * read here from what is stored, so every caller (the handler, the opening,
 * the sweep) reaches the same answer. Taking a released claim back can find
 * the number held by another account meanwhile: the opening is then stopped
 * (`stopped`, `CLAIM_LOST`), never left claiming a number it does not hold.
 * An expired opening never takes its number back. Idempotent; safe to call
 * after every state change.
 */
export async function alignClaim(
  prisma: ClaimPrisma,
  wawuUserId: string,
): Promise<ClaimAlignment> {
  const row = await prisma.fintavaWalletOpening.findUnique({
    where: { wawuUserId },
    select: { bvnHash: true, provider: true, state: true, failure: true },
  });
  if (!row || row.provider !== 'nuvion') return 'none';
  if (row.state === 'stopped' && row.failure === CLAIM_LOST) return 'stopped';
  const [entity, wallet] = await Promise.all([
    prisma.nuvionEntity.findUnique({
      where: { wawuUserId },
      select: HOLD_ENTITY_SELECT,
    }),
    prisma.fintavaWallet.findUnique({
      where: { wawuUserId },
      select: { wawuUserId: true },
    }),
  ]);
  const hold = holdsBvn(holdFactsOf(row.state, entity, wallet !== null));
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
