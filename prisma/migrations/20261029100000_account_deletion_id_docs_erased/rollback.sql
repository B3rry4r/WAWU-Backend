\set ON_ERROR_STOP on
-- Rollback for 20261029100000_account_deletion_id_docs_erased (SETTINGS-09).
-- Run with: psql -1 -f rollback.sql
-- Refuses (and changes nothing) while any deletion row records that ID
-- documents were deleted (idDocsErasedAt set, or idDocsErased above 0): the
-- columns are the only record of it, and the files cannot be brought back. Stop
-- the sweep first only if you mean to lose that record, and copy it out.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "AccountDeletion"
     WHERE "idDocsErasedAt" IS NOT NULL OR "idDocsErased" > 0
  ) THEN
    RAISE EXCEPTION 'SETTINGS-09 rollback: ID documents were already deleted for at least one account and these columns are the record of it. Nothing was changed.';
  END IF;
END $$;
ALTER TABLE "AccountDeletion"
  DROP COLUMN "idDocsKeepDays",
  DROP COLUMN "idDocsErased",
  DROP COLUMN "idDocsErasedAt",
  DROP COLUMN "idDocsClaimedUntil";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261029100000_account_deletion_id_docs_erased';
