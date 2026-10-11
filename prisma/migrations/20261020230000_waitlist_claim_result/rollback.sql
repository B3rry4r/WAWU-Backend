-- Rollback for 20261020230000_waitlist_claim_result (JOIN-03 round 2). Run with: psql -1 -f rollback.sql
ALTER TABLE "WaitlistRegistration" DROP COLUMN "claimResult";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261020230000_waitlist_claim_result';
