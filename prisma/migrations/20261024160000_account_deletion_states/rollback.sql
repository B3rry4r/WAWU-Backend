\set ON_ERROR_STOP on
-- Rollback for 20261024160000_account_deletion_states (SETTINGS-06 round 2).
-- Run with: psql -1 -f rollback.sql
-- Refuses (and changes nothing) while a deletion is freezing or purging: the
-- old check would not accept those rows. It also refuses while a cancelled
-- deletion has not been confirmed (walletSyncedAt null): its wallet may still
-- be frozen, and this rollback drops the column the hourly pass uses to find
-- it. Wait for a pass (it runs every hour), then roll back.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "AccountDeletion" WHERE "status" IN ('freezing', 'purging')) THEN
    RAISE EXCEPTION 'SETTINGS-06 rollback: a deletion is freezing or purging. Cancel or finish it first. Nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM "AccountDeletion" WHERE "status" = 'cancelled' AND "walletSyncedAt" IS NULL) THEN
    RAISE EXCEPTION 'SETTINGS-06 rollback: a cancelled deletion still owes an unfreeze check (walletSyncedAt is null). Let the hourly pass confirm it first. Nothing was changed.';
  END IF;
END $$;
ALTER TABLE "AccountDeletion" DROP COLUMN "walletSyncedAt";
ALTER TABLE "AccountDeletion" DROP COLUMN "purgeNote";
ALTER TABLE "AccountDeletion" DROP CONSTRAINT "AccountDeletion_status_check";
ALTER TABLE "AccountDeletion" ADD CONSTRAINT "AccountDeletion_status_check"
  CHECK ("status" IN ('scheduled', 'cancelled', 'purged'));
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261024160000_account_deletion_states';
