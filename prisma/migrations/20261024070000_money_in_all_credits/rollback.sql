\set ON_ERROR_STOP on
-- Rollback for 20261024070000_money_in_all_credits. Run by hand, never by
-- `prisma migrate deploy` (it only reads migration.sql). Drops the two new
-- columns and nothing else. The "before" marks the migration wrote stay: the
-- WALLET-10 code ignores a row it did not write and they stop it from being
-- told if the migration is applied again. Afterwards, delete the row for this
-- migration from "_prisma_migrations" so a redeploy can reapply.
ALTER TABLE "MoneyInNotice"
  DROP COLUMN "correctedAt",
  DROP COLUMN "correctionNotificationId";
