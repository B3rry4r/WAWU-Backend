-- Rollback for 20261024110000_ads_explore_slider (ADS-07).
-- Run with: psql -1 -f rollback.sql
-- Postgres cannot drop one value from an enum, so this recreates "AdPlacement"
-- without 'explore_slider'. Campaigns on the slider are taken off air and kept
-- (status ended, placement today_slot), because AdEvent and AdDailyTotal point
-- at them with RESTRICT foreign keys and their counts must not be lost.
-- Checked by the ADS-07 verifier: with explore_slider rows holding counts, then
-- rolled forward again.
BEGIN;
UPDATE "AdCampaign" SET status='ended', placement='today_slot' WHERE placement='explore_slider';
ALTER TYPE "AdPlacement" RENAME TO "AdPlacement_old";
CREATE TYPE "AdPlacement" AS ENUM ('tgif_card','today_slot');
DROP INDEX "AdCampaign_placement_status_startsAt_endsAt_idx";
ALTER TABLE "AdCampaign" ALTER COLUMN placement TYPE "AdPlacement" USING placement::text::"AdPlacement";
CREATE INDEX "AdCampaign_placement_status_startsAt_endsAt_idx" ON "AdCampaign"(placement,status,"startsAt","endsAt");
DROP TYPE "AdPlacement_old";
DELETE FROM _prisma_migrations WHERE migration_name='20261024110000_ads_explore_slider';
COMMIT;
