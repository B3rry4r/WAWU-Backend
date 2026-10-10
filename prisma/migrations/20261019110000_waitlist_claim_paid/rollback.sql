-- Rollback for 20261019110000_waitlist_claim_paid (JOIN-03). Run with: psql -1 -f rollback.sql
ALTER TABLE "WaitlistRegistration" DROP CONSTRAINT "WaitlistRegistration_claim_paid_check";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261019110000_waitlist_claim_paid';
