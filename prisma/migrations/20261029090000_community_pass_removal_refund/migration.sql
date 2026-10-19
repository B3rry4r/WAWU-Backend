-- INBOX-25 (R-71): a member the host removes gets the unused days of their paid
-- monthly pass back.
--
-- Additive only. One new nullable column ("CommunityPass"."refundId", set once
-- when the pass's unused days are paid back) and three new tables:
--   "CommunityPassRefund"   the refund WAWU pays from its merchant account to
--                           the member's wallet (one row per removal that had
--                           days to give back; the same move machinery as a
--                           hold's refund: our reference, a lease, a provider
--                           record as the truth);
--   "EarningDeduction"      the host's 85% of those days, taken back from the
--                           host's earnings and never from their wallet;
--   "EarningDeductionTake"  what one daily move took of one deduction.
-- No existing column, constraint, trigger or index changes. The web and the
-- dashboard never read these tables or the new column.
--
-- Rollback: rollback.sql in this folder. It refuses to run while any refund,
-- deduction or take row exists or any pass carries a refund id, because those
-- rows are money records that cannot be rebuilt.

-- AlterTable
ALTER TABLE "CommunityPass" ADD COLUMN "refundId" TEXT;

-- CreateTable
CREATE TABLE "CommunityPassRefund" (
    "id" TEXT NOT NULL,
    "communityId" TEXT NOT NULL,
    "userWawuId" TEXT NOT NULL,
    "hostWawuId" TEXT NOT NULL,
    "removedAt" TIMESTAMP(3) NOT NULL,
    "unusedDays" INTEGER NOT NULL,
    "amountKobo" BIGINT NOT NULL,
    "hostShareKobo" BIGINT NOT NULL,
    "merchantAccountNumber" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'fintava',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "settledAt" TIMESTAMP(3),
    "customerReference" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "destinationAccountNumber" TEXT,
    "sentAt" TIMESTAMP(3),
    "providerFeeKobo" BIGINT,
    "nextAttemptAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "checks" INTEGER NOT NULL DEFAULT 0,
    "waiting" TEXT,
    "reviewSince" TIMESTAMP(3),
    "discrepancy" TEXT,
    "notifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommunityPassRefund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EarningDeduction" (
    "id" TEXT NOT NULL,
    "payeeWawuUserId" TEXT NOT NULL,
    "passRefundId" TEXT NOT NULL,
    "amountKobo" BIGINT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'fintava',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EarningDeduction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EarningDeductionTake" (
    "id" TEXT NOT NULL,
    "deductionId" TEXT NOT NULL,
    "moveId" TEXT NOT NULL,
    "amountKobo" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EarningDeductionTake_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CommunityPass_refundId_idx" ON "CommunityPass"("refundId");

-- CreateIndex
CREATE UNIQUE INDEX "CommunityPassRefund_customerReference_key" ON "CommunityPassRefund"("customerReference");

-- CreateIndex
CREATE INDEX "CommunityPassRefund_status_reviewSince_nextAttemptAt_idx" ON "CommunityPassRefund"("status", "reviewSince", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "CommunityPassRefund_userWawuId_createdAt_idx" ON "CommunityPassRefund"("userWawuId", "createdAt");

-- CreateIndex
CREATE INDEX "CommunityPassRefund_communityId_idx" ON "CommunityPassRefund"("communityId");

-- CreateIndex
CREATE UNIQUE INDEX "EarningDeduction_passRefundId_key" ON "EarningDeduction"("passRefundId");

-- CreateIndex
CREATE INDEX "EarningDeduction_payeeWawuUserId_idx" ON "EarningDeduction"("payeeWawuUserId");

-- CreateIndex
CREATE UNIQUE INDEX "EarningDeductionTake_deductionId_moveId_key" ON "EarningDeductionTake"("deductionId", "moveId");

-- CreateIndex
CREATE INDEX "EarningDeductionTake_moveId_idx" ON "EarningDeductionTake"("moveId");

-- AddForeignKey
ALTER TABLE "EarningDeductionTake" ADD CONSTRAINT "EarningDeductionTake_deductionId_fkey" FOREIGN KEY ("deductionId") REFERENCES "EarningDeduction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EarningDeductionTake" ADD CONSTRAINT "EarningDeductionTake_moveId_fkey" FOREIGN KEY ("moveId") REFERENCES "EarningMove"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CheckConstraints: whole positive kobo, and a status the code knows.
ALTER TABLE "CommunityPassRefund" ADD CONSTRAINT "CommunityPassRefund_status_check"
    CHECK ("status" IN ('pending', 'refunded'));
ALTER TABLE "CommunityPassRefund" ADD CONSTRAINT "CommunityPassRefund_amount_check"
    CHECK ("amountKobo" > 0 AND "hostShareKobo" >= 0 AND "hostShareKobo" <= "amountKobo"
           AND "unusedDays" >= 1 AND "attempt" >= 1);
ALTER TABLE "CommunityPassRefund" ADD CONSTRAINT "CommunityPassRefund_settled_check"
    CHECK (("status" = 'pending') = ("settledAt" IS NULL));
ALTER TABLE "EarningDeduction" ADD CONSTRAINT "EarningDeduction_amount_check"
    CHECK ("amountKobo" > 0);
ALTER TABLE "EarningDeductionTake" ADD CONSTRAINT "EarningDeductionTake_amount_check"
    CHECK ("amountKobo" > 0);

-- A deduction is never taken beyond what it is: the takes of one deduction sum
-- to at most its amount, checked when a take is written (the move's own
-- transaction holds the deduction row locked, so two moves cannot both pass).
CREATE FUNCTION "EarningDeductionTake_guard"() RETURNS trigger AS $$
DECLARE
  d RECORD;
  taken BIGINT;
BEGIN
  SELECT "amountKobo" INTO d FROM "EarningDeduction" WHERE "id" = NEW."deductionId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'EarningDeductionTake: deduction % does not exist', NEW."deductionId";
  END IF;
  SELECT COALESCE(SUM("amountKobo"), 0) INTO taken
    FROM "EarningDeductionTake"
   WHERE "deductionId" = NEW."deductionId" AND "id" <> NEW."id";
  IF taken + NEW."amountKobo" > d."amountKobo" THEN
    RAISE EXCEPTION 'EarningDeductionTake: deduction % cannot be taken beyond its amount', NEW."deductionId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "EarningDeductionTake_guard_trigger"
    BEFORE INSERT OR UPDATE OF "amountKobo" ON "EarningDeductionTake"
    FOR EACH ROW EXECUTE FUNCTION "EarningDeductionTake_guard"();
