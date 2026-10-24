-- NUV-11 fix round 1 (R-10). Sends abroad: the give-back of WAWU's fee after a failed or reversed send (when it was given back,
-- when it was held for a person, how many tries), the partner's fee the review showed (from config) and whether the real one
-- differed. Additive only: six nullable or defaulted columns on two tables created by 20261113093000_abroad_sends.

-- AlterTable
ALTER TABLE "AbroadQuote" ADD COLUMN     "providerFeeEstimateMinor" BIGINT;

-- AlterTable
ALTER TABLE "AbroadSend" ADD COLUMN     "feeBackAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "feeBackHeldAt" TIMESTAMP(3),
ADD COLUMN     "feeDiffers" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "feeGivenBackAt" TIMESTAMP(3),
ADD COLUMN     "providerFeeEstimateMinor" BIGINT;

