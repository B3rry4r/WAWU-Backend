-- REF-01 (owner, 14 Oct 2026): referral codes on the paid registration page /join.
-- A code names the community a registrant came from and can lower the price
-- they pay (0, which is free, up to the offer's price), with an optional limit.
--
-- Additive: one new table, two NULLABLE columns on WaitlistRegistration, one
-- new index, and the insert of the first code. Two CHECK constraints on
-- WaitlistRegistration are WIDENED, never narrowed, so a free (price 0) coded
-- registration can be stored: its fee may be 0, and a paid row with no
-- Flutterwave transaction id is allowed when it is a free coded row (fee 0 and
-- paid 0). Every row that exists today satisfies the new rules, and an older
-- instance never writes such a row. A row made before this migration keeps
-- NULL in the new columns and its fee untouched.
--
-- The first code the owner asked for: LOGOART, ₦1,200 for the first 4,000.
-- ON CONFLICT DO NOTHING, so running this where the code already exists (or
-- again) changes nothing.
--
-- Rollback (also in rollback.sql); refuses while a free registration exists:
--   see rollback.sql

CREATE TABLE "ReferralCode" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "community" TEXT NOT NULL,
  "priceKobo" INTEGER NOT NULL,
  "usageLimit" INTEGER,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReferralCode_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReferralCode_code_check" CHECK ("code" ~ '^[A-Z0-9]{3,20}$'),
  CONSTRAINT "ReferralCode_priceKobo_check" CHECK ("priceKobo" >= 0),
  CONSTRAINT "ReferralCode_usageLimit_check" CHECK ("usageLimit" IS NULL OR "usageLimit" >= 0)
);
CREATE UNIQUE INDEX "ReferralCode_code_key" ON "ReferralCode"("code");

ALTER TABLE "WaitlistRegistration"
  ADD COLUMN "referralCode" TEXT,
  ADD COLUMN "referralCommunity" TEXT;

CREATE INDEX "WaitlistRegistration_referralCode_status_createdAt_idx"
  ON "WaitlistRegistration"("referralCode", "status", "createdAt");

-- Widen: a coded registration may be free.
ALTER TABLE "WaitlistRegistration" DROP CONSTRAINT "WaitlistRegistration_amountKobo_check";
ALTER TABLE "WaitlistRegistration" ADD CONSTRAINT "WaitlistRegistration_amountKobo_check"
  CHECK ("amountKobo" > 0 OR ("amountKobo" = 0 AND "referralCode" IS NOT NULL));

-- Widen: a paid row needs a Flutterwave transaction id unless it is a free coded row.
ALTER TABLE "WaitlistRegistration" DROP CONSTRAINT "WaitlistRegistration_paid_check";
ALTER TABLE "WaitlistRegistration" ADD CONSTRAINT "WaitlistRegistration_paid_check"
  CHECK (
    "status" <> 'paid'
    OR (
      "paidAt" IS NOT NULL AND "paidKobo" IS NOT NULL
      AND ("flutterwaveTxId" IS NOT NULL OR ("amountKobo" = 0 AND "paidKobo" = 0 AND "referralCode" IS NOT NULL))
    )
  );

INSERT INTO "ReferralCode" ("id", "code", "community", "priceKobo", "usageLimit", "active", "updatedAt")
VALUES (gen_random_uuid()::text, 'LOGOART', 'LOGOART', 120000, 4000, true, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;
