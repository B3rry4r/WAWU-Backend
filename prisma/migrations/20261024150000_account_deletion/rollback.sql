-- Rollback for 20261024150000_account_deletion (SETTINGS-06). Run with: psql -1 -f rollback.sql
-- Refuses (and changes nothing) while a deletion is scheduled: dropping the
-- table would forget which wallets are frozen and which content is hidden.
-- It also refuses while a cancelled deletion still owes an unfreeze: a row not
-- yet confirmed (walletSyncedAt null, checked while that column exists, that
-- is when 20261024160000 has not been rolled back first) or, in the shape
-- before that column, one that still records a frozen wallet.
DO $$
DECLARE
  owed bigint := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM "AccountDeletion" WHERE "status" = 'scheduled') THEN
    RAISE EXCEPTION 'SETTINGS-06 rollback: a deletion is scheduled. Cancel or purge it first. Nothing was changed.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'AccountDeletion'
      AND column_name = 'walletSyncedAt'
  ) THEN
    EXECUTE 'SELECT count(*) FROM "AccountDeletion" WHERE "status" = ''cancelled'' AND "walletSyncedAt" IS NULL' INTO owed;
    IF owed > 0 THEN
      RAISE EXCEPTION 'SETTINGS-06 rollback: a cancelled deletion still owes an unfreeze check (walletSyncedAt is null). Let the hourly pass confirm it first. Nothing was changed.';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM "AccountDeletion" WHERE "status" = 'cancelled' AND "walletFrozenAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'SETTINGS-06 rollback: a cancelled deletion still records a frozen wallet. Unfreeze it first. Nothing was changed.';
  END IF;
END $$;
DROP TABLE "AccountDeletionContent";
DROP TABLE "AccountDeletion";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261024150000_account_deletion';
