import type { Prisma } from '../../generated/prisma/client';

/**
 * An admin's takedown of a professional listing, kept apart from the
 * person's own Hide (FIX-06).
 *
 * `ProfessionalProfile.listed` is still what every reader goes by (the two
 * directories, the profiles, the feed's suggestions), and it stays false
 * while a takedown stands. What is new is the WHO: a ProfessionalTakedown
 * row with `liftedAt` null says an admin pulled the listing, so the person's
 * Show is refused and only an admin puts it back. The person's own Hide and
 * Show on a listing no admin pulled behave exactly as before.
 *
 * Every write that reads or changes a takedown first locks the listing's row
 * (`lockListing`), so a person's Show and an admin's unlist landing at the
 * same moment cannot interleave into "taken down, but listed".
 */

/** `reason.code` on the person's Show of a listing an admin took down. */
export const LISTING_TAKEN_DOWN = 'listing_taken_down';

/** The sentence beside it. Read by the web and the app. */
export const LISTING_TAKEN_DOWN_MESSAGE =
  'This listing was taken down by an admin and cannot be shown. It stays hidden until an admin lists it again.';

/** `reason.code` on an admin's relist of a listing no takedown holds. */
export const LISTING_NOT_TAKEN_DOWN = 'listing_not_taken_down';

/** Where the owner's listing stands in the directory. */
export type ProfessionalListingVisibility = 'listed' | 'hidden' | 'taken_down';

/**
 * GET /professionals/applications/mine/visibility: one approved listing of
 * the caller's, and whether it is in the directory, hidden by the caller, or
 * taken down by an admin. A pending or turned-down application is not a
 * listing yet and is not in this list (GET /professionals/applications/mine
 * has every application with its status).
 */
export interface ProfessionalListingVisibilityView {
  /** The listing's id, as GET /professionals/applications/mine gives it. */
  id: string;
  category: string;
  /**
   * `listed`: in the directory. `hidden`: the owner pressed Hide and can
   * Show it. `taken_down`: an admin took it down; the owner's Show is
   * refused (409, reason.code `listing_taken_down`) until an admin lists it
   * again.
   */
  visibility: ProfessionalListingVisibility;
  /** When an admin took it down. Null unless `visibility` is `taken_down`. */
  takenDownAt: Date | null;
}

/**
 * Locks one listing's row until the transaction ends. False when there is no
 * such listing.
 */
export async function lockListing(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<
    Array<{ id: string }>
  >`SELECT "id" FROM "ProfessionalProfile" WHERE "id" = ${id} FOR UPDATE`;
  return rows.length > 0;
}

/** The takedown that stands on this listing, or null. */
export function standingTakedown(tx: Prisma.TransactionClient, id: string) {
  return tx.professionalTakedown.findFirst({
    where: { professionalId: id, liftedAt: null },
  });
}

/** The visibility a listing's owner sees, from its row and its takedown. */
export function visibilityOf(
  listed: boolean,
  takenDownAt: Date | null,
): ProfessionalListingVisibility {
  if (takenDownAt) return 'taken_down';
  return listed ? 'listed' : 'hidden';
}
