/**
 * Money helpers shared by the modules that settle payments.
 *
 * Naira only — this product has no other currency (CLAUDE.md). Every amount
 * in this codebase is a whole-naira integer; `commissionRate` is the
 * Decimal(5,4) snapshotted onto the Purchase row at transaction time
 * (85/15 on every stream but WAWU Credits, which is 90/10 for everyone and
 * always was — never recomputed, never invented).
 */

/** Prisma hands Decimal columns back as a Decimal instance, not a number. */
type DecimalLike = { toString(): string } | number;

/**
 * What the creator actually keeps from a settled Purchase, rounded to whole
 * naira. Used by the "you sold something" / "you were tipped" notifications
 * so they quote the same figure the earnings screen will.
 */
export function netOfCommission(
  amount: number,
  commissionRate: DecimalLike,
): number {
  const rate = Number(commissionRate.toString());
  return Math.round(amount * (1 - rate));
}
