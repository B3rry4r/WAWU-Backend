\set ON_ERROR_STOP on
-- Rollback for 20261021240000_waitlist_craft_city_updates (JOIN-V2). Run with: psql -1 -f rollback.sql
ALTER TABLE "WaitlistRegistration" DROP COLUMN "craft", DROP COLUMN "city", DROP COLUMN "updatesOptIn";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261021240000_waitlist_craft_city_updates';
