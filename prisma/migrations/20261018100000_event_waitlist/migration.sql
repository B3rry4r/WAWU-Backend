-- JOIN-01: the event registration link (R-48). A person registers for an event
-- offer on the website and pays the event fee by Flutterwave checkout; the
-- registration is a waiting-list row, not an account. Additive: one new enum
-- and one new table; no existing table, column, index or row is touched.
--
-- What the database itself guarantees, whatever the code does:
--   * at most one `paid` row per offer and phone, and one per offer and email,
--     so two payments racing for the same person leave one registration;
--   * a Flutterwave transaction id belongs to one row (unique);
--   * the reference (the tx_ref) is unique and at least 32 characters;
--   * an email is stored lower case; the fee is above zero;
--   * a `paid` row always says which transaction paid it and when;
--   * a claim names who and when together, or neither.
--
-- Rollback (nothing else references this table):
--   DROP TABLE "WaitlistRegistration"; DROP TYPE "WaitlistStatus";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261018100000_event_waitlist';

-- CreateEnum
CREATE TYPE "WaitlistStatus" AS ENUM ('pending', 'paid', 'failed');

-- CreateTable
CREATE TABLE "WaitlistRegistration" (
    "id" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "state" TEXT,
    "makes" TEXT,
    "consentAt" TIMESTAMP(3) NOT NULL,
    "reference" TEXT NOT NULL,
    "status" "WaitlistStatus" NOT NULL DEFAULT 'pending',
    "amountKobo" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "flutterwaveTxId" TEXT,
    "paidKobo" INTEGER,
    "paidAt" TIMESTAMP(3),
    "claimedByWawuId" TEXT,
    "claimedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WaitlistRegistration_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "WaitlistRegistration_reference_check" CHECK (length("reference") >= 32),
    CONSTRAINT "WaitlistRegistration_email_check" CHECK ("email" = lower("email")),
    CONSTRAINT "WaitlistRegistration_amountKobo_check" CHECK ("amountKobo" > 0),
    CONSTRAINT "WaitlistRegistration_currency_check" CHECK ("currency" = 'NGN'),
    CONSTRAINT "WaitlistRegistration_paid_check" CHECK ("status" <> 'paid' OR ("flutterwaveTxId" IS NOT NULL AND "paidAt" IS NOT NULL AND "paidKobo" IS NOT NULL)),
    CONSTRAINT "WaitlistRegistration_claim_check" CHECK (("claimedByWawuId" IS NULL) = ("claimedAt" IS NULL))
);

-- CreateIndex
CREATE UNIQUE INDEX "WaitlistRegistration_reference_key" ON "WaitlistRegistration"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "WaitlistRegistration_flutterwaveTxId_key" ON "WaitlistRegistration"("flutterwaveTxId");

-- CreateIndex
CREATE INDEX "WaitlistRegistration_offerId_status_createdAt_idx" ON "WaitlistRegistration"("offerId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "WaitlistRegistration_phone_idx" ON "WaitlistRegistration"("phone");

-- CreateIndex
CREATE INDEX "WaitlistRegistration_email_idx" ON "WaitlistRegistration"("email");

-- CreateIndex
CREATE INDEX "WaitlistRegistration_claimedByWawuId_idx" ON "WaitlistRegistration"("claimedByWawuId");

-- At most one paid registration per offer and phone, and per offer and email.
-- Prisma cannot write a partial unique index; this is the database constraint.
CREATE UNIQUE INDEX "WaitlistRegistration_one_paid_phone_key" ON "WaitlistRegistration"("offerId", "phone") WHERE "status" = 'paid';

CREATE UNIQUE INDEX "WaitlistRegistration_one_paid_email_key" ON "WaitlistRegistration"("offerId", "email") WHERE "status" = 'paid';
