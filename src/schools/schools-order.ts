import { Prisma } from '../../generated/prisma/client';

/**
 * The one order of the schools list, written into the query (FIX-27).
 *
 * A text column sorts by the collation its database was created with. CI's
 * `postgres:16` image sorts `en_US.utf8` (glibc), a droplet or a laptop may
 * sort `C.UTF-8`, an ICU database sorts a third way, and they disagree about
 * case, spaces, punctuation, accents, emoji and characters glibc gives no
 * weight at all. A list left to the column therefore came in a different
 * order on each, and a test written against one failed on another. Naming the
 * order here makes it the same on every database, and since the page's
 * `ORDER BY` and the cursor's comparison are built from the same three
 * expressions below, they cannot disagree about it either.
 *
 * The order:
 *
 *   1. the name with ASCII capitals lower-cased, by code point (UTF-8 byte
 *      order), so "iLearn Academy" sits among the I's and "Zuri" and "zeta"
 *      sit together;
 *   2. then the exact name, by code point, so names that differ only in case
 *      come capitals first and a name is never equal to another unless the
 *      two are the same text;
 *   3. then the id, by code point.
 *
 * Every step is in the `"C"` collation, which Postgres builds in on every
 * install (no ICU or glibc locale is needed). `lower()` under `"C"` lowers
 * ASCII only, the same on every database; the default `lower()` follows the
 * database's locale and does not. The inbox keyset (INBOX-07) pins `"C"` the
 * same way for its text key.
 *
 * What people see, against an `en_US` database: names in the usual Title Case
 * keep their place, and lower-case first letters ("eHealth", "iLearn") keep
 * theirs. What moves: names that differ only in a space, hyphen or apostrophe
 * ("Dee-Jay Music" and "Dee Jay Studio"), and names that start with an
 * accented letter, which now come after the Z's.
 *
 * The cursor still holds `[name, id]`; the lower-cased key is worked out here
 * from the name, so the cursor text and its bounds (schools-cursor.ts) are
 * unchanged.
 */
const C = Prisma.sql`COLLATE "C"`;

/** The three sort expressions for the `School` row aliased as `s`. */
function rowKey(): Prisma.Sql {
  return Prisma.sql`lower(s."name" ${C}), s."name" ${C}, s."id" ${C}`;
}

/** The same three, for a cursor's name and id given as parameters. */
function cursorKey(after: { name: string; id: string }): Prisma.Sql {
  return Prisma.sql`lower(${after.name}::text ${C}), ${after.name}::text ${C}, ${after.id}::text ${C}`;
}

/** `ORDER BY` for the list: the three expressions, ascending. */
export function schoolOrderBy(): Prisma.Sql {
  return Prisma.sql`ORDER BY ${rowKey()}`;
}

/** True for the schools strictly after the cursor's position in that order. */
export function schoolsAfter(after: { name: string; id: string }): Prisma.Sql {
  return Prisma.sql`(${rowKey()}) > (${cursorKey(after)})`;
}
