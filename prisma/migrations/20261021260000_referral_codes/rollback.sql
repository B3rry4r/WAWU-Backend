-- Rollback for 20261021260000_referral_codes (REF-01). Run with: psql -1 -f rollback.sql
-- Refuses (and changes nothing) while a free registration exists: the old rules
-- cannot hold a fee of 0 or a paid row with no transaction id. Settle those first.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "WaitlistRegistration" WHERE "amountKobo" = 0 OR ("status" = 'paid' AND "flutterwaveTxId" IS NULL)) THEN
    RAISE EXCEPTION 'REF-01 rollback: free registrations exist. Nothing was changed.';
  END IF;
END $$;
ALTER TABLE "WaitlistRegistration" DROP CONSTRAINT "WaitlistRegistration_paid_check";
ALTER TABLE "WaitlistRegistration" ADD CONSTRAINT "WaitlistRegistration_paid_check"
  CHECK ("status" <> 'paid' OR ("flutterwaveTxId" IS NOT NULL AND "paidAt" IS NOT NULL AND "paidKobo" IS NOT NULL));
ALTER TABLE "WaitlistRegistration" DROP CONSTRAINT "WaitlistRegistration_amountKobo_check";
ALTER TABLE "WaitlistRegistration" ADD CONSTRAINT "WaitlistRegistration_amountKobo_check" CHECK ("amountKobo" > 0);
DROP INDEX "WaitlistRegistration_referralCode_status_createdAt_idx";
ALTER TABLE "WaitlistRegistration" DROP COLUMN "referralCode", DROP COLUMN "referralCommunity";
DROP TABLE "ReferralCode";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261021260000_referral_codes';
