-- JOIN-V2 (owner redesign of /join, 12 Oct 2026): the registration form now asks
-- what the person makes or does (a choice from a list), which conference city
-- they will attend (Lagos, Abuja, Port Harcourt, Enugu or Online) and whether
-- they want launch and conference updates.
--
-- Additive: three NULLABLE columns on one table. No existing column, index,
-- constraint or value is changed, and an older instance never reads or writes
-- them. A row written before this migration, or by a client that sends none of
-- them, keeps NULL. `updatesOptIn` is NULL when the question was not asked,
-- false when it was asked and declined, true when accepted. The lists of
-- allowed values live in the application (`waitlist-config.ts`), not in a
-- CHECK, so the owner can change a list without a migration.
--
-- Rollback (also in rollback.sql):
--   ALTER TABLE "WaitlistRegistration" DROP COLUMN "craft", DROP COLUMN "city", DROP COLUMN "updatesOptIn";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261021240000_waitlist_craft_city_updates';

ALTER TABLE "WaitlistRegistration"
  ADD COLUMN "craft" TEXT,
  ADD COLUMN "city" TEXT,
  ADD COLUMN "updatesOptIn" BOOLEAN;
