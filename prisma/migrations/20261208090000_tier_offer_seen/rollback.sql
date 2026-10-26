\set ON_ERROR_STOP on
-- Rollback of 20261208090000_tier_offer_seen (TIER-OFFER, R-94). Run it only after the Hub build that reads and writes these rows is gone.
-- Run with: psql -1 -f rollback.sql
-- Refuses (and changes nothing) while any row exists: each row is the only record that a person has been shown the offer, and
-- dropping it would show the offer to them again. Clear them only on purpose, after the owner has decided:
--   DELETE FROM "TierOfferSeen";
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "TierOfferSeen") THEN
    RAISE EXCEPTION 'TIER-OFFER rollback: records of who has been shown the tier offer are stored and would be lost. Nothing was changed.';
  END IF;
END $$;
DROP TABLE "TierOfferSeen";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261208090000_tier_offer_seen';
