-- TIER-04: more products bought on a tier, from the wallet or by bank transfer
-- (R-43, R-44, R-65). One row per PAID purchase, written in the transaction
-- that adds the products to "MakerTier"."extraProducts"; its primary key is the
-- wallet payment's id, so one payment adds once. The count is the one the buyer
-- was quoted (an admin setting), kept here so a later change to the setting
-- never changes what was bought. The money figures live in the payment.
--
-- Additive: one new table. No existing table, column, index or row is touched
-- and no relation is added to an existing model, so no live response gains a
-- key (protected route registry, H-1).
--
-- Rollback:
--   DROP TABLE "MakerExtraProducts";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261025030000_maker_extra_products';
--   (the products already added stay in "MakerTier"."extraProducts"; rolling
--   back the table does not take them away.)

-- CreateTable
CREATE TABLE "MakerExtraProducts" (
    "paymentRef" TEXT NOT NULL,
    "wawuUserId" TEXT NOT NULL,
    "tierId" TEXT NOT NULL,
    "products" INTEGER NOT NULL,
    "currency" "BillingCurrency" NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MakerExtraProducts_pkey" PRIMARY KEY ("paymentRef"),
    CONSTRAINT "MakerExtraProducts_tierId_check" CHECK (length("tierId") > 0),
    CONSTRAINT "MakerExtraProducts_products_check" CHECK ("products" >= 1),
    CONSTRAINT "MakerExtraProducts_amountMinor_check" CHECK ("amountMinor" >= 1)
);

-- CreateIndex
CREATE INDEX "MakerExtraProducts_wawuUserId_createdAt_idx" ON "MakerExtraProducts"("wawuUserId", "createdAt");
