-- JOIN-TIERS-HUB (owner, 2 and 3 Nov 2026, R-125): /join sells the app's three
-- tiers, a code prices one tier, and a paid registration is claimed
-- automatically by the signed-in person whose proven email or phone it holds.
--
-- Additive only: three NULLABLE columns, one widened CHECK, no default, no rewrite of a row's
-- meaning. WaitlistRegistration.tier NULL = the old offer's tier (Verify),
-- so the 39 paid registrations stay claimable exactly as they were.
-- ReferralCode.tier NULL = not bound to a tier (old behaviour). The one data
-- change binds LOGOART to Verify, as the owner ruled (3 Nov): its price,
-- cap and count are untouched. Safe to run again.

ALTER TABLE "WaitlistRegistration"
  ADD COLUMN "tier" TEXT,
  ADD COLUMN "claimedVia" TEXT;

ALTER TABLE "ReferralCode"
  ADD COLUMN "tier" TEXT;

UPDATE "ReferralCode" SET "tier" = 'verify' WHERE "code" = 'LOGOART' AND "tier" IS NULL;

-- Widen (never narrow): a tier given for a /join payment is recorded as a
-- purchase with method `web_join`, beside `wallet` and `store`. Every row that
-- exists satisfies the wider rule; an older instance never writes `web_join`.
ALTER TABLE "MakerPurchase" DROP CONSTRAINT "MakerPurchase_method_check";
ALTER TABLE "MakerPurchase" ADD CONSTRAINT "MakerPurchase_method_check" CHECK ("method" IN ('wallet', 'store', 'web_join'));
