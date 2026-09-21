/**
 * What WAWU keeps on a sale: 15%, leaving the creator 85%.
 *
 * ONE rate now. The 10% paid-tier rate went with the tier that sold it
 * (build brief B1 removes subscriptions), so every creator is on the standard
 * split that CLAUDE.md documents as 85/15.
 *
 * This is not a new rate and not a rate anybody's terms changed under them:
 * 85/15 is what a creator without a paid plan was already charged, and the
 * live API reports zero successful payments ever, so nobody was on 90/10.
 * Inventing a rate is forbidden; so is quietly keeping a better one alive for
 * a plan that no longer exists.
 *
 * WAWU Credits are the deliberate exception at 90/10 for everyone, and always
 * were tier-independent. See credit-spend.service.ts — do not collapse the two.
 *
 * A free ticket is charged nothing, so there is nothing to take a cut of.
 */
export const STANDARD_COMMISSION_RATE = 0.15;

/** The rate for every organiser. Takes no argument: there is nothing left to vary on. */
export function commissionRate(): number {
  return STANDARD_COMMISSION_RATE;
}

/**
 * How many tickets one order may hold.
 *
 * A ceiling exists because each ticket is a row and a QR code, and an order
 * for fifty thousand would be a denial of service dressed as a group booking.
 * A "Table of 10" tier sells one ticket type ten times, not one order of ten
 * thousand.
 */
export const MAX_TICKETS_PER_ORDER = 50;
