\set ON_ERROR_STOP on
-- Rollback of 20261203090000_legal_acceptance (LEGAL-DOCS). Run it only after the Hub build that writes these records is gone.
-- Run with: psql -1 -f rollback.sql
-- Refuses (and changes nothing) while any record exists: each row is the only proof of which version of which document a person
-- agreed to, and when. Export them first on purpose (for example \copy "LegalAcceptance" TO 'legal-acceptance.csv' CSV HEADER) and
-- clear them only after the owner has decided:
--   DELETE FROM "LegalAcceptance";
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "LegalAcceptance") THEN
    RAISE EXCEPTION 'LEGAL-DOCS rollback: records of what people agreed to are stored and would be lost. Nothing was changed.';
  END IF;
END $$;
DROP TABLE "LegalAcceptance";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261203090000_legal_acceptance';
