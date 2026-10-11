-- TIER-03: a tier bought, renewed or upgraded from the wallet (R-43, R-44).
-- One row per PAID purchase, written in the transaction that grants what it
-- bought; its primary key is the wallet payment's id, so one payment grants
-- once. No price or points figure is stored here except the amount that was
-- charged: the figures live in src/plans/plans.config.json.
--
-- Additive: one new table. No existing table, column, index or row is
-- touched, and no relation is added to an existing model, so no live
-- response gains a key (protected route registry, H-1).
--
-- Rollback:
--   DROP TABLE "MakerPurchase";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261021140000_maker_purchase';

-- CreateTable
CREATE TABLE "MakerPurchase" (
    "paymentRef" TEXT NOT NULL,
    "wawuUserId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "tierId" TEXT NOT NULL,
    "fromTierId" TEXT,
    "bump" BOOLEAN NOT NULL DEFAULT false,
    "currency" "BillingCurrency" NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'wallet',
    "status" TEXT NOT NULL DEFAULT 'paid',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MakerPurchase_pkey" PRIMARY KEY ("paymentRef"),
    CONSTRAINT "MakerPurchase_kind_check" CHECK ("kind" IN ('tier', 'renew', 'upgrade')),
    CONSTRAINT "MakerPurchase_tierId_check" CHECK (length("tierId") > 0),
    -- An upgrade names the tier it came from; no other kind does.
    CONSTRAINT "MakerPurchase_fromTierId_check" CHECK (("kind" = 'upgrade') = ("fromTierId" IS NOT NULL)),
    CONSTRAINT "MakerPurchase_amountMinor_check" CHECK ("amountMinor" >= 1),
    CONSTRAINT "MakerPurchase_method_check" CHECK ("method" IN ('wallet')),
    CONSTRAINT "MakerPurchase_status_check" CHECK ("status" IN ('paid'))
);

-- CreateIndex
CREATE INDEX "MakerPurchase_wawuUserId_createdAt_idx" ON "MakerPurchase"("wawuUserId", "createdAt");
