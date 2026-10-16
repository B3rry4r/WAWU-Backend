-- JOIN-01 round 4: the launch access code is unique across ALL registrations.
--
-- The short reference each payer sees ("XXXX XXXX", the first 8 hex characters
-- of the reference after `wawu-join-`) is what they redeem their launch
-- discount with. It is derived from the 144-bit reference, so two references
-- can share it (about one pair in 4.3 billion). This adds the code as a column
-- the database COMPUTES from `reference` (GENERATED ALWAYS ... STORED), upper
-- case, and a unique index on it:
--   * every existing row is backfilled by the add itself (no UPDATE, no code
--     changes any holder's code), and a new row can never disagree with its
--     reference because nothing writes the column;
--   * a row inserted by the version of the app that is still running during a
--     deploy (which does not know the column) gets its code too;
--   * a second registration with a taken code is refused by the database
--     (23505); the application then draws a new reference and tries again.
--
-- Additive: one column and one index on one table; no existing column, index,
-- constraint or row value is changed.
--
-- If two EXISTING rows already share a code, this migration stops with an
-- exception that names how many codes and how many of those rows are `paid`,
-- and changes nothing (one transaction). A code someone already holds is never
-- rewritten here: report it, do not work around it. Check before deploying:
--   SELECT upper(substr("reference", 11, 8)) AS code, count(*), count(*) FILTER (WHERE "status" = 'paid') AS paid
--   FROM "WaitlistRegistration" GROUP BY 1 HAVING count(*) > 1;
--
-- Rollback (nothing else references the column; also in rollback.sql):
--   DROP INDEX "WaitlistRegistration_accessCode_key";
--   ALTER TABLE "WaitlistRegistration" DROP COLUMN "accessCode";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261019100000_waitlist_access_code';

-- AlterTable: a stored generated column; Postgres computes it for every existing row.
ALTER TABLE "WaitlistRegistration"
  ADD COLUMN "accessCode" TEXT GENERATED ALWAYS AS (upper(substr("reference", 11, 8))) STORED NOT NULL;

-- Stop, rather than change anyone's code, if two existing rows already share one.
DO $$
DECLARE
  shared integer;
  shared_rows integer;
  shared_paid integer;
BEGIN
  SELECT count(*), coalesce(sum(n), 0), coalesce(sum(paid), 0)
    INTO shared, shared_rows, shared_paid
  FROM (
    SELECT count(*) AS n, count(*) FILTER (WHERE "status" = 'paid') AS paid
    FROM "WaitlistRegistration"
    GROUP BY "accessCode"
    HAVING count(*) > 1
  ) AS dup;
  IF shared > 0 THEN
    RAISE EXCEPTION 'JOIN-01 access code: % code(s) are shared by % existing registration(s), % of them paid. Nothing was changed. Report this to the lead; do not rewrite a code someone holds.', shared, shared_rows, shared_paid;
  END IF;
END $$;

-- CreateIndex
CREATE UNIQUE INDEX "WaitlistRegistration_accessCode_key" ON "WaitlistRegistration"("accessCode");
