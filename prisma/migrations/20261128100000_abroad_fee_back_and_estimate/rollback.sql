\set ON_ERROR_STOP on
-- Rollback of 20261128100000_abroad_fee_back_and_estimate (NUV-11 round 1). Run it only after the Hub build that reads these
-- columns is gone. Run with: psql -1 -f rollback.sql
-- Refuses (and changes nothing) while any send holds a fee given back, a fee held for a person, a shown estimate or a flagged
-- difference: dropping the columns would lose the only record that WAWU's fee went back to a person, or that finance has to look.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "AbroadSend"
    WHERE "feeGivenBackAt" IS NOT NULL OR "feeBackHeldAt" IS NOT NULL OR "providerFeeEstimateMinor" IS NOT NULL OR "feeDiffers"
  ) THEN
    RAISE EXCEPTION 'NUV-11 round 1 rollback: sends hold a fee given back, a held fee, an estimate or a flagged difference and would lose them. Nothing was changed.';
  END IF;
END $$;
ALTER TABLE "AbroadSend" DROP COLUMN "feeGivenBackAt", DROP COLUMN "feeBackHeldAt", DROP COLUMN "feeBackAttempts", DROP COLUMN "providerFeeEstimateMinor", DROP COLUMN "feeDiffers";
ALTER TABLE "AbroadQuote" DROP COLUMN "providerFeeEstimateMinor";
