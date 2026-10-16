-- Rollback for 20261024030000_account_deletion (SETTINGS-06). Run with: psql -1 -f rollback.sql
-- Refuses (and changes nothing) while a deletion is scheduled: dropping the
-- table would forget which wallets are frozen and which content is hidden.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "AccountDeletion" WHERE "status" = 'scheduled') THEN
    RAISE EXCEPTION 'SETTINGS-06 rollback: a deletion is scheduled. Cancel or purge it first. Nothing was changed.';
  END IF;
END $$;
DROP TABLE "AccountDeletionContent";
DROP TABLE "AccountDeletion";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261024030000_account_deletion';
