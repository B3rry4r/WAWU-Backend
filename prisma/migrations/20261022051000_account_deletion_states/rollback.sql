-- Rollback for 20261022051000_account_deletion_states (SETTINGS-06 round 2).
-- Run with: psql -1 -f rollback.sql
-- Refuses (and changes nothing) while a deletion is freezing or purging: the
-- old check would not accept those rows.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "AccountDeletion" WHERE "status" IN ('freezing', 'purging')) THEN
    RAISE EXCEPTION 'SETTINGS-06 rollback: a deletion is freezing or purging. Cancel or finish it first. Nothing was changed.';
  END IF;
END $$;
ALTER TABLE "AccountDeletion" DROP COLUMN "walletSyncedAt";
ALTER TABLE "AccountDeletion" DROP COLUMN "purgeNote";
ALTER TABLE "AccountDeletion" DROP CONSTRAINT "AccountDeletion_status_check";
ALTER TABLE "AccountDeletion" ADD CONSTRAINT "AccountDeletion_status_check"
  CHECK ("status" IN ('scheduled', 'cancelled', 'purged'));
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261022051000_account_deletion_states';
