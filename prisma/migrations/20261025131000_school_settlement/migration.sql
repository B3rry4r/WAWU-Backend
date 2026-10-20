-- SCHOOLS-11: pay schools their share of course fees.
--
-- Additive only: one nullable column and two new tables. No existing column,
-- index or constraint changes.
--
-- CourseIntake."cancelledAt": when a class was called off (the dashboard hides
-- it at the same moment, so nothing that lists classes changes).
--
-- SchoolPayee: the bank account a school is paid at, stored only for an
-- account the provider's name check confirmed.
--
-- SchoolSettlement: one row per paid enrolment, the first decision about its
-- fee (pay the school at the class's start, or send the fee back to the
-- student when the class is called off). "enrolmentId" is unique, so only one
-- decision can be made; the CHECKs hold the vocabulary and the split
-- ("schoolShareKobo" + "wawuShareKobo" = "priceKobo"), and "attempt" to the
-- original reference and one retry.
--
-- Rollback: DROP TABLE "SchoolSettlement"; DROP TABLE "SchoolPayee";
-- ALTER TABLE "CourseIntake" DROP COLUMN "cancelledAt". Nothing else refers to
-- them.

-- AlterTable
ALTER TABLE "CourseIntake" ADD COLUMN     "cancelledAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "SchoolPayee" (
    "schoolId" TEXT NOT NULL,
    "bankCode" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL,
    "counterpartyId" TEXT,
    "paymentDetailId" TEXT,
    "setBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SchoolPayee_pkey" PRIMARY KEY ("schoolId")
);

-- CreateTable
CREATE TABLE "SchoolSettlement" (
    "id" TEXT NOT NULL,
    "enrolmentId" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "holdId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "priceKobo" INTEGER NOT NULL,
    "schoolShareKobo" INTEGER NOT NULL,
    "wawuShareKobo" INTEGER NOT NULL,
    "bankCode" TEXT,
    "bankName" TEXT,
    "bankAccountNumber" TEXT,
    "bankAccountName" TEXT,
    "counterpartyId" TEXT,
    "paymentDetailId" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "checks" INTEGER NOT NULL DEFAULT 0,
    "customerReference" TEXT,
    "sentAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "waiting" TEXT,
    "providerFeeKobo" BIGINT,
    "providerTransactionId" TEXT,
    "reviewNote" TEXT,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SchoolSettlement_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SchoolSettlement_action_check" CHECK ("action" IN ('payout', 'refund')),
    CONSTRAINT "SchoolSettlement_status_check" CHECK ("status" IN ('pending', 'sent', 'paid', 'refunded', 'review')),
    CONSTRAINT "SchoolSettlement_shares_check" CHECK ("schoolShareKobo" >= 0 AND "wawuShareKobo" >= 0 AND "schoolShareKobo" + "wawuShareKobo" = "priceKobo"),
    CONSTRAINT "SchoolSettlement_attempt_check" CHECK ("attempt" BETWEEN 1 AND 2 AND "attempts" >= 0 AND "checks" >= 0)
);

-- CreateIndex
CREATE UNIQUE INDEX "SchoolSettlement_enrolmentId_key" ON "SchoolSettlement"("enrolmentId");

-- CreateIndex
CREATE UNIQUE INDEX "SchoolSettlement_customerReference_key" ON "SchoolSettlement"("customerReference");

-- CreateIndex
CREATE INDEX "SchoolSettlement_status_nextAttemptAt_idx" ON "SchoolSettlement"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "SchoolSettlement_schoolId_status_idx" ON "SchoolSettlement"("schoolId", "status");

-- AddForeignKey
ALTER TABLE "SchoolPayee" ADD CONSTRAINT "SchoolPayee_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolSettlement" ADD CONSTRAINT "SchoolSettlement_enrolmentId_fkey" FOREIGN KEY ("enrolmentId") REFERENCES "SchoolEnrolment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolSettlement" ADD CONSTRAINT "SchoolSettlement_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

