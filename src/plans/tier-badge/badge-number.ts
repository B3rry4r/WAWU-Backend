import type { Prisma } from '../../../generated/prisma/client';

type Tx = Prisma.TransactionClient;

/** The one row of BadgeNumberCounter: every numbered badge draws from it. */
export const NUMBERED_BADGE_COUNTER = 'numbered_badge';

/**
 * The number on this person's numbered badge, given now if they have none.
 *
 * Called by the tier grant, inside its transaction and after it took the
 * person's tier lock (`lockPersonTier`), so one person is numbered one grant
 * at a time and a person who has a number keeps it: this returns the stored
 * one and writes nothing.
 *
 * A new number is the counter plus one, taken by a single statement. Two
 * buyers at once queue on the counter row for the length of the surrounding
 * transaction (no network call is made inside it), so they never get the same
 * number; a grant that rolls back rolls the counter back with it, so there is
 * no gap; and the counter is never below the highest number already given,
 * even if its row was edited or is missing. The unique index on
 * `MakerTier.badgeNumber` is the last guard.
 */
export async function ensureBadgeNumber(
  tx: Tx,
  wawuUserId: string,
): Promise<number> {
  const held = await tx.makerTier.findUnique({
    where: { wawuUserId },
    select: { badgeNumber: true },
  });
  if (held === null)
    throw new Error('A badge number is given to a person who holds a tier.');
  if (held.badgeNumber !== null) return held.badgeNumber;

  const rows = await tx.$queryRaw<{ last: number }[]>`
    INSERT INTO "BadgeNumberCounter" ("name", "last")
    VALUES (
      ${NUMBERED_BADGE_COUNTER},
      (SELECT COALESCE(MAX("badgeNumber"), 0) + 1 FROM "MakerTier")
    )
    ON CONFLICT ("name") DO UPDATE SET "last" = GREATEST(
      "BadgeNumberCounter"."last",
      (SELECT COALESCE(MAX("badgeNumber"), 0) FROM "MakerTier")
    ) + 1
    RETURNING "last"`;
  const number = Number(rows[0]?.last);
  if (!Number.isSafeInteger(number) || number < 1)
    throw new Error('The badge counter did not answer a number.');
  await tx.makerTier.update({
    where: { wawuUserId },
    data: { badgeNumber: number },
  });
  return number;
}
