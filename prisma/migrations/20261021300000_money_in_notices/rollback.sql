-- Rollback for 20261021300000_money_in_notices. Run by hand, never by
-- `prisma migrate deploy` (it only reads migration.sql). Drops the new table,
-- its enum and the index, and nothing else. Afterwards, delete the row for
-- this migration from "_prisma_migrations" so a redeploy can reapply.
DROP TABLE "MoneyInNotice";
DROP TYPE "MoneyInNoticeOutcome";
DROP INDEX "FintavaLedgerEntry_direction_category_createdAt_idx";
