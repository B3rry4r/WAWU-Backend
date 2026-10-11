-- Hold, release and refund (task MONEY-18).
--
-- Additive only: one new table ("WalletHold") and one nullable column on
-- "WalletPayment" ("chargeReviewSince"). No existing column, index or row
-- changes meaning, and nothing is backfilled: a held kind could not be paid
-- before this task, so there is no payment a hold should exist for.
--
-- WalletHold: one row per completed held payment (a paid DM, an event ticket,
-- a bill), written in the same transaction as the payment's completion. The
-- price waits in WAWU's own account at the wallet provider (R-19) until the
-- owning feature RELEASES it (the payee's 85%) or REFUNDS it (the price, not
-- the provider's charge on the original payment, R-10). Every figure is BIGINT
-- kobo. `customerReference` is unique: one move out of WAWU's account per
-- reference, so a repeat can never move the money twice at the provider.
--
-- What the database refuses, so the rules hold whatever the code does:
--   * a status other than held, released or refunded; an action other than
--     release or refund;
--   * a settled hold without a settled time, or a held one with one;
--   * a refund that does not return the whole price, or a release or refund
--     recorded against the other action;
--   * a split that is not the price;
--   * a hold that leaves a settled state, or whose action changes once set
--     (a hold is settled once, one way: the trigger below).
--
-- "WalletPayment"."chargeReviewSince": the provider's charge on a payment was
-- below 0 or above the quoted fee by more than PAYMENT_CHARGE_REVIEW_ABOVE_KOBO
-- (MONEY-18, N2); a person looks before the payment completes or is delivered.
--
-- Rollback: DROP TABLE "WalletHold"; DROP FUNCTION "WalletHold_guard"();
-- ALTER TABLE "WalletPayment" DROP COLUMN "chargeReviewSince";

-- AlterTable
ALTER TABLE "WalletPayment" ADD COLUMN     "chargeReviewSince" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "WalletHold" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "payerWawuUserId" TEXT,
    "payeeWawuUserId" TEXT,
    "kind" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "releaseCondition" TEXT NOT NULL,
    "amountKobo" BIGINT NOT NULL,
    "payeeShareKobo" BIGINT NOT NULL,
    "wawuShareKobo" BIGINT NOT NULL,
    "merchantAccountNumber" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'fintava',
    "status" TEXT NOT NULL DEFAULT 'held',
    "heldAt" TIMESTAMP(3) NOT NULL,
    "settledAt" TIMESTAMP(3),
    "refundedKobo" BIGINT,
    "action" TEXT,
    "actionReason" TEXT,
    "actionAt" TIMESTAMP(3),
    "transferKobo" BIGINT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "customerReference" TEXT,
    "destinationAccountNumber" TEXT,
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

    CONSTRAINT "WalletHold_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WalletHold_paymentId_key" ON "WalletHold"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "WalletHold_customerReference_key" ON "WalletHold"("customerReference");

-- CreateIndex
CREATE INDEX "WalletHold_status_action_reviewSince_nextAttemptAt_idx" ON "WalletHold"("status", "action", "reviewSince", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "WalletHold_payerWawuUserId_heldAt_idx" ON "WalletHold"("payerWawuUserId", "heldAt");

-- CreateIndex
CREATE INDEX "WalletHold_payeeWawuUserId_heldAt_idx" ON "WalletHold"("payeeWawuUserId", "heldAt");

-- AddForeignKey
ALTER TABLE "WalletHold" ADD CONSTRAINT "WalletHold_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "WalletPayment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CheckConstraints
ALTER TABLE "WalletHold" ADD CONSTRAINT "WalletHold_status_check"
    CHECK ("status" IN ('held', 'released', 'refunded'));
ALTER TABLE "WalletHold" ADD CONSTRAINT "WalletHold_action_check"
    CHECK ("action" IS NULL OR "action" IN ('release', 'refund'));
ALTER TABLE "WalletHold" ADD CONSTRAINT "WalletHold_amounts_check"
    CHECK ("amountKobo" > 0 AND "payeeShareKobo" >= 0 AND "wawuShareKobo" >= 0
           AND "payeeShareKobo" + "wawuShareKobo" = "amountKobo");
ALTER TABLE "WalletHold" ADD CONSTRAINT "WalletHold_settled_check"
    CHECK (("status" = 'held') = ("settledAt" IS NULL));
ALTER TABLE "WalletHold" ADD CONSTRAINT "WalletHold_outcome_check"
    CHECK (
      ("status" = 'held')
      OR ("status" = 'released' AND "action" = 'release' AND "refundedKobo" IS NULL)
      OR ("status" = 'refunded' AND "action" = 'refund' AND "refundedKobo" = "amountKobo")
    );

-- A hold is settled once, one way. Once `action` is set it never changes, and
-- a settled hold (released or refunded) never changes its status, action,
-- amounts or refund again. Everything else (the schedule, the review mark,
-- notes) stays writable.
CREATE FUNCTION "WalletHold_guard"() RETURNS trigger AS $$
BEGIN
  IF OLD."action" IS NOT NULL AND NEW."action" IS DISTINCT FROM OLD."action" THEN
    RAISE EXCEPTION 'WalletHold %: the action of a hold never changes', OLD."id";
  END IF;
  IF OLD."status" <> 'held' AND (
       NEW."status" IS DISTINCT FROM OLD."status"
    OR NEW."settledAt" IS DISTINCT FROM OLD."settledAt"
    OR NEW."refundedKobo" IS DISTINCT FROM OLD."refundedKobo"
    OR NEW."amountKobo" IS DISTINCT FROM OLD."amountKobo"
    OR NEW."payeeShareKobo" IS DISTINCT FROM OLD."payeeShareKobo"
    OR NEW."transferKobo" IS DISTINCT FROM OLD."transferKobo"
    OR NEW."customerReference" IS DISTINCT FROM OLD."customerReference"
  ) THEN
    RAISE EXCEPTION 'WalletHold %: a settled hold never changes', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "WalletHold_guard_trigger"
    BEFORE UPDATE ON "WalletHold"
    FOR EACH ROW EXECUTE FUNCTION "WalletHold_guard"();
