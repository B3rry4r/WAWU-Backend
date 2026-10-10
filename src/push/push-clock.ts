import { Prisma } from '../../generated/prisma/client';

/**
 * The one clock the push tables are written and read with (INBOX-03).
 *
 * Every time column here is `timestamp` without a zone holding UTC, which is
 * what Prisma writes. SQL `now()` is a `timestamptz`; written into or
 * compared with such a column it is read in the SESSION's time zone, so on a
 * database whose zone is not UTC (Africa/Lagos is one hour ahead) a value
 * written from Node and one written with `now()` disagree by the offset:
 * retries and receipt checks fire early or hours late, and a phone registered
 * a minute ago is taken to have been registered an hour from now.
 *
 * So every push query uses this, the database's own clock in UTC, for every
 * write and every comparison, and no time is written from Node's clock.
 */
export const NOW_UTC = Prisma.sql`(now() AT TIME ZONE 'UTC')`;
