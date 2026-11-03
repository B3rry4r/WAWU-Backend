\set ON_ERROR_STOP on
-- Rollback for 20261231090000_join_tiers (JOIN-TIERS-HUB). Run with: psql -1 -f rollback.sql
-- Drops the three columns. It refuses while any registration names a tier (paid or
-- pending), any web_join purchase exists, or a code is bound to a tier other than verify.
DO $$
BEGIN
  -- Any registration that names a tier, paid or still pending: after a rollback
  -- it would settle as an old no-tier row and be claimed as Verify.
  IF EXISTS (SELECT 1 FROM "WaitlistRegistration" WHERE "tier" IS NOT NULL) THEN
    RAISE EXCEPTION 'JOIN-TIERS rollback: registrations that name a tier exist. Nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM "MakerPurchase" WHERE "method" = 'web_join') THEN
    RAISE EXCEPTION 'JOIN-TIERS rollback: web_join purchase records exist. Nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM "ReferralCode" WHERE "tier" IS NOT NULL AND "tier" <> 'verify') THEN
    RAISE EXCEPTION 'JOIN-TIERS rollback: referral codes bound to a tier other than verify exist. Nothing was changed.';
  END IF;
END $$;
ALTER TABLE "MakerPurchase" DROP CONSTRAINT "MakerPurchase_method_check";
ALTER TABLE "MakerPurchase" ADD CONSTRAINT "MakerPurchase_method_check" CHECK ("method" IN ('wallet', 'store'));
ALTER TABLE "ReferralCode" DROP COLUMN "tier";
ALTER TABLE "WaitlistRegistration" DROP COLUMN "claimedVia", DROP COLUMN "tier";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261231090000_join_tiers';
