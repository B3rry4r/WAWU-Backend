-- STORE-BUY-HUB round 3 (R-101). Additive in effect; nothing the web or the dashboard calls reads any of it.
--
--   * "StorePurchase"."wawuUserId" loses NOT NULL. When an account is deleted the purchase is KEPT with the buyer cleared
--     (the account map's ANONYMISED rule, as WalletPayment's payer), so a later store refund still finds the transaction
--     and takes the creator's 85% back. Every existing row has a buyer; the column is only relaxed.
--   * "StorePurchase"."lastNoticeAt": the signed date of the last refund, revoke or reversal notice seen for the
--     transaction, so notices that arrive out of order end where the store's order ends.
--   * "StoreCredit": what a fan paid for a ladder purchase that could not be given (the piece, creator or room was gone
--     when the payment arrived). Worth the list price, usable once, whole, on a later piece, tip or pass at that price or
--     less, never cash, never expires. One per source purchase.
--
-- Rollback: rollback.sql in this folder. It refuses while any credit, any purchase with its buyer cleared, or any notice
-- date exists, because those are records of money.

ALTER TABLE "StorePurchase" ALTER COLUMN "wawuUserId" DROP NOT NULL;
ALTER TABLE "StorePurchase" ADD COLUMN "lastNoticeAt" TIMESTAMP(3);

CREATE TABLE "StoreCredit" (
    "id" TEXT NOT NULL,
    "wawuUserId" TEXT NOT NULL,
    "amountKobo" INTEGER NOT NULL,
    "sourcePurchaseId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "spentPurchaseId" TEXT,
    "spentAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreCredit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StoreCredit_sourcePurchaseId_key" ON "StoreCredit"("sourcePurchaseId");
CREATE UNIQUE INDEX "StoreCredit_spentPurchaseId_key" ON "StoreCredit"("spentPurchaseId");
CREATE INDEX "StoreCredit_wawuUserId_status_idx" ON "StoreCredit"("wawuUserId", "status");

ALTER TABLE "StoreCredit" ADD CONSTRAINT "StoreCredit_status_check"
    CHECK ("status" IN ('open', 'spent', 'void') AND "amountKobo" > 0);
ALTER TABLE "StoreCredit" ADD CONSTRAINT "StoreCredit_state_check"
    CHECK (("status" = 'spent') = ("spentAt" IS NOT NULL AND "spentPurchaseId" IS NOT NULL)
           AND ("status" = 'void') = ("voidedAt" IS NOT NULL));
