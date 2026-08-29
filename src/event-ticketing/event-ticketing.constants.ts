/**
 * What WAWU keeps on a ticket sale.
 *
 * The SAME rates as everything else on the platform: 15% standard, 10% for a
 * paid tier. Ticketing does not get a rate of its own — CLAUDE.md is explicit
 * that a split is 85/15 or 90/10 and never invented, and an organiser who
 * already understands their content split should not have to learn a second
 * number for events.
 *
 * A free ticket is charged nothing, so there is nothing to take a cut of.
 */
export const STANDARD_COMMISSION_RATE = 0.15;
export const PAID_TIER_COMMISSION_RATE = 0.1;

/** The rate for an organiser, by their creator tier. */
export function commissionRateForTier(tier: string | null | undefined): number {
  return tier === 'pro' || tier === 'pro_max'
    ? PAID_TIER_COMMISSION_RATE
    : STANDARD_COMMISSION_RATE;
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
