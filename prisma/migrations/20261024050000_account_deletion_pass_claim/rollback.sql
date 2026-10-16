-- Rollback for 20261024050000_account_deletion_pass_claim (SETTINGS-06 round 7).
-- Run with: psql -1 -f rollback.sql
-- Drops the claim column; the pass then takes rows without a claim again.
ALTER TABLE "AccountDeletion" DROP COLUMN "reconcileClaimedUntil";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261024050000_account_deletion_pass_claim';
