-- Rollback of 20261019100000_waitlist_access_code (JOIN-01 round 4). Nothing else references the column.
DROP INDEX "WaitlistRegistration_accessCode_key";
ALTER TABLE "WaitlistRegistration" DROP COLUMN "accessCode";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261019100000_waitlist_access_code';
