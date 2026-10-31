\set ON_ERROR_STOP on
-- Rollback for 20261228090000_ugc_reports (REPORT-UGC). It refuses while any row exists: a row is a report a moderator
-- may still have to answer, and the only record that a person asked for something to be looked at. Resolve or export
-- the reports first (GET /admin/reports), delete the rows on purpose, then run this. Run with: psql -1 -f rollback.sql
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "UgcReport") THEN
    RAISE EXCEPTION 'rollback refused: a UgcReport row exists';
  END IF;
END $$;

DROP TABLE "UgcReport";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261228090000_ugc_reports';
