-- STORE-PAYOUT (R-101 point 4): WAWU pays a creator's 85% of a store sale from its own account at the wallet
-- provider, 3 working days after the sale.
--
-- Additive only. Two new tables ("StoreEarningPayout": one transfer per "StoreEarning"; "StoreAdminNotice": a notice
-- for the owner that the dashboard lists) and one loosening of an existing table: "EarningDeductionTake"."moveId" may
-- now be empty, because a deduction can be taken by a store payout as well as by a creator's daily move. A new nullable
-- column "storePayoutId" names the payout that took it; exactly one of the two is set (a CHECK). The deduction guard
-- trigger already sums every take of a deduction, so it covers the new takes without change. Nothing the web or the
-- dashboard reads changes: both tables are new, and no existing row has an empty "moveId".
--
-- One existing check is widened: "StoreEarning"."status" may also be 'sending' (a payout's transfer is out; a store refund
-- in that time must be taken back as a deduction, as for a paid earning, not cancelled). No existing row has it.
--
-- Rollback: rollback.sql in this folder. It refuses while any payout, take by a payout, notice or 'sending' earning exists,
-- because those rows are money records that cannot be rebuilt.

-- CreateTable
CREATE TABLE "StoreEarningPayout" (
    "id" TEXT NOT NULL,
    "storeEarningId" TEXT NOT NULL,
    "payeeWawuUserId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "grossKobo" BIGINT NOT NULL,
    "deductedKobo" BIGINT NOT NULL DEFAULT 0,
    "amountKobo" BIGINT NOT NULL,
    "merchantAccountNumber" TEXT NOT NULL,
    "destinationAccountNumber" TEXT,
    "customerReference" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "settledAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "providerFeeKobo" BIGINT,
    "nextAttemptAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "checks" INTEGER NOT NULL DEFAULT 0,
    "waiting" TEXT,
    "reviewSince" TIMESTAMP(3),
    "discrepancy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreEarningPayout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreAdminNotice" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "noticeKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),
    "readByAdminId" TEXT,

    CONSTRAINT "StoreAdminNotice_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "EarningDeductionTake" ALTER COLUMN "moveId" DROP NOT NULL;
ALTER TABLE "EarningDeductionTake" ADD COLUMN "storePayoutId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "StoreEarningPayout_storeEarningId_key" ON "StoreEarningPayout"("storeEarningId");
CREATE UNIQUE INDEX "StoreEarningPayout_customerReference_key" ON "StoreEarningPayout"("customerReference");
CREATE INDEX "StoreEarningPayout_status_reviewSince_nextAttemptAt_idx" ON "StoreEarningPayout"("status", "reviewSince", "nextAttemptAt");
CREATE INDEX "StoreEarningPayout_payeeWawuUserId_idx" ON "StoreEarningPayout"("payeeWawuUserId");
CREATE UNIQUE INDEX "StoreAdminNotice_noticeKey_key" ON "StoreAdminNotice"("noticeKey");
CREATE INDEX "StoreAdminNotice_createdAt_idx" ON "StoreAdminNotice"("createdAt");
CREATE INDEX "StoreAdminNotice_readAt_createdAt_idx" ON "StoreAdminNotice"("readAt", "createdAt");
CREATE UNIQUE INDEX "EarningDeductionTake_deductionId_storePayoutId_key" ON "EarningDeductionTake"("deductionId", "storePayoutId");
CREATE INDEX "EarningDeductionTake_storePayoutId_idx" ON "EarningDeductionTake"("storePayoutId");

-- AddForeignKey
ALTER TABLE "EarningDeductionTake" ADD CONSTRAINT "EarningDeductionTake_storePayoutId_fkey" FOREIGN KEY ("storePayoutId") REFERENCES "StoreEarningPayout"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CheckConstraints: whole kobo that add up, a status the code knows, and a take made by one thing only.
ALTER TABLE "StoreEarningPayout" ADD CONSTRAINT "StoreEarningPayout_amounts_check"
    CHECK ("grossKobo" > 0 AND "deductedKobo" >= 0 AND "amountKobo" >= 0
           AND "deductedKobo" + "amountKobo" = "grossKobo" AND "attempt" >= 1);
ALTER TABLE "StoreEarningPayout" ADD CONSTRAINT "StoreEarningPayout_status_check"
    CHECK ("status" IN ('pending', 'paid', 'cancelled'));
ALTER TABLE "StoreEarningPayout" ADD CONSTRAINT "StoreEarningPayout_settled_check"
    CHECK (("status" = 'paid') = ("settledAt" IS NOT NULL));
ALTER TABLE "EarningDeductionTake" ADD CONSTRAINT "EarningDeductionTake_one_taker_check"
    CHECK (("moveId" IS NULL) <> ("storePayoutId" IS NULL));

-- The earning's status may also be 'sending' (see above); the state check (paid/cancelled dates) is unchanged.
ALTER TABLE "StoreEarning" DROP CONSTRAINT "StoreEarning_status_check";
ALTER TABLE "StoreEarning" ADD CONSTRAINT "StoreEarning_status_check"
    CHECK ("status" IN ('owed', 'sending', 'paid', 'cancelled') AND "role" IN ('sale', 'restore'));
