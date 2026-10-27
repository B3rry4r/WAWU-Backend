-- STORE-BUY-HUB (R-101, owner, 27 Oct 2026): in the app, unlocking a piece, a tip and a community pass are store
-- purchases at the list price, from one ladder of consumables, `wawu.buy.<naira>`. The creator gets exactly 85% of the
-- LIST price, 3 working days after the sale; WAWU keeps the rest.
--
-- Additive only. Nothing the web or the dashboard calls reads any of this:
--   * "StoreProductKind" gains `buy`, and a new enum "StoreIntentKind" (content, tip, pass) and "StoreIntentStatus";
--   * "StoreProduct"."storePriceKobo" (nullable): the Nigeria store price of a `buy` product;
--   * "StorePurchase" gains nullable "intentId" (unique), "buyKind" and "targetId";
--   * "StorePurchaseIntent": what a ladder purchase is for, recorded before the store sheet opens. At most ONE open
--     intent per person, kind and target (a partial unique index);
--   * "StoreEarning": the creator's 85% of the list price with the day it may be paid ("availableAt"). It is its own
--     table, not "EarningSettlement", which the daily mover reads: nothing here can be paid early;
--   * "EarningDeduction" gains nullable "storePurchaseId" (unique) and "passRefundId" loses NOT NULL, with a check that
--     exactly one of the two is set. A store refund of an earning that was already paid is a deduction, which the
--     creator's next daily move takes (it reads "EarningDeduction" as it is); it is never taken from a wallet.
--
-- The `buy` value is not used in this file (a new enum value cannot be used in the transaction that adds it); the
-- ladder rows are the next migration.
--
-- Rollback: rollback.sql in this folder. It refuses while any intent, store earning, ladder purchase or
-- store-sourced deduction exists, because those are records of money.

ALTER TYPE "StoreProductKind" ADD VALUE IF NOT EXISTS 'buy';

-- CreateEnum
CREATE TYPE "StoreIntentKind" AS ENUM ('content', 'tip', 'pass');

-- CreateEnum
CREATE TYPE "StoreIntentStatus" AS ENUM ('open', 'used', 'replaced', 'expired');

-- AlterTable
ALTER TABLE "StoreProduct" ADD COLUMN "storePriceKobo" INTEGER;

-- AlterTable
ALTER TABLE "StorePurchase" ADD COLUMN "intentId" TEXT,
ADD COLUMN "buyKind" "StoreIntentKind",
ADD COLUMN "targetId" TEXT;

-- AlterTable
ALTER TABLE "EarningDeduction" ALTER COLUMN "passRefundId" DROP NOT NULL,
ADD COLUMN "storePurchaseId" TEXT;

-- CreateTable
CREATE TABLE "StorePurchaseIntent" (
    "id" TEXT NOT NULL,
    "wawuUserId" TEXT NOT NULL,
    "platform" "StorePlatform" NOT NULL,
    "kind" "StoreIntentKind" NOT NULL,
    "targetId" TEXT NOT NULL,
    "listPriceNaira" INTEGER NOT NULL,
    "listPriceKobo" INTEGER NOT NULL,
    "productId" TEXT NOT NULL,
    "storeProductId" TEXT NOT NULL,
    "status" "StoreIntentStatus" NOT NULL DEFAULT 'open',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StorePurchaseIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreEarning" (
    "id" TEXT NOT NULL,
    "storePurchaseId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'sale',
    "source" TEXT NOT NULL DEFAULT 'store',
    "payeeWawuUserId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "earnedAt" TIMESTAMP(3) NOT NULL,
    "listPriceKobo" BIGINT NOT NULL,
    "amountKobo" BIGINT NOT NULL,
    "availableAt" TIMESTAMP(3) NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'owed',
    "paidAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreEarning_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StorePurchase_intentId_key" ON "StorePurchase"("intentId");

-- CreateIndex
CREATE UNIQUE INDEX "EarningDeduction_storePurchaseId_key" ON "EarningDeduction"("storePurchaseId");

-- CreateIndex
CREATE INDEX "StorePurchaseIntent_wawuUserId_kind_targetId_idx" ON "StorePurchaseIntent"("wawuUserId", "kind", "targetId");

-- CreateIndex
CREATE INDEX "StorePurchaseIntent_status_expiresAt_idx" ON "StorePurchaseIntent"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "StoreEarning_storePurchaseId_role_key" ON "StoreEarning"("storePurchaseId", "role");

-- CreateIndex
CREATE INDEX "StoreEarning_payeeWawuUserId_status_idx" ON "StoreEarning"("payeeWawuUserId", "status");

-- CreateIndex
CREATE INDEX "StoreEarning_status_availableAt_idx" ON "StoreEarning"("status", "availableAt");

-- One OPEN intent per person, kind and target. A second ask finds the first; a different price or store replaces it
-- (the old one becomes `replaced`, in the same transaction).
CREATE UNIQUE INDEX "StorePurchaseIntent_one_open_key"
    ON "StorePurchaseIntent"("wawuUserId", "kind", "targetId") WHERE "status" = 'open';

-- CheckConstraints
ALTER TABLE "StorePurchaseIntent" ADD CONSTRAINT "StorePurchaseIntent_price_check"
    CHECK ("listPriceNaira" > 0 AND "listPriceKobo" = "listPriceNaira" * 100);
ALTER TABLE "StorePurchaseIntent" ADD CONSTRAINT "StorePurchaseIntent_used_check"
    CHECK (("status" = 'used') = ("usedAt" IS NOT NULL));
ALTER TABLE "StoreEarning" ADD CONSTRAINT "StoreEarning_status_check"
    CHECK ("status" IN ('owed', 'paid', 'cancelled') AND "role" IN ('sale', 'restore'));
ALTER TABLE "StoreEarning" ADD CONSTRAINT "StoreEarning_amount_check"
    CHECK ("listPriceKobo" > 0 AND "amountKobo" > 0 AND "amountKobo" <= "listPriceKobo" AND "availableAt" >= "earnedAt");
ALTER TABLE "StoreEarning" ADD CONSTRAINT "StoreEarning_state_check"
    CHECK (("status" = 'paid') = ("paidAt" IS NOT NULL) AND ("status" = 'cancelled') = ("cancelledAt" IS NOT NULL));
ALTER TABLE "StoreProduct" ADD CONSTRAINT "StoreProduct_store_price_check"
    CHECK ("storePriceKobo" IS NULL OR "storePriceKobo" > 0);
ALTER TABLE "EarningDeduction" ADD CONSTRAINT "EarningDeduction_one_source_check"
    CHECK (("passRefundId" IS NULL) <> ("storePurchaseId" IS NULL));
