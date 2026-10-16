-- TIER-03: a tier bought, renewed or upgraded from the wallet (R-43, R-44).
-- One row per PAID purchase, written in the transaction that grants what it
-- bought; its primary key is the wallet payment's id, so one payment grants
-- once. No price or points figure is stored here except the amount that was
-- charged: the figures live in src/plans/plans.config.json.
--
-- Additive: one new table and one CHECK on an existing one (below). No
-- existing column, index or row is touched, and no relation is added to an
-- existing model, so no live response gains a key (protected route registry,
-- H-1).
--
-- The CHECK (round 2, lead note N7 of TIER-01): "PersonBilling" may not hold
-- a currency fixed by a first purchase without the purchase that fixed it.
-- Only this task writes `first_purchase` (always with the payment's id), and
-- it is not deployed yet, so no row can break the check; `support` rows (a
-- person at WAWU, by hand) name no purchase and stay as they are. The other
-- N7 state, a "MakerTier" whose "activeFrom" is in the future, is NOT checked
-- here: a CHECK against the database clock would refuse a grant when the
-- application server's clock runs ahead of the database's, after the money was
-- taken, and TIER-01's own spec grants "as of" a fixed date later than today.
-- The code never writes it (specs kill a mutant that does).
--
-- Rollback:
--   ALTER TABLE "PersonBilling" DROP CONSTRAINT "PersonBilling_firstPurchaseRef_check";
--   DROP TABLE "MakerPurchase";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261021160500_maker_purchase';

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

-- A currency fixed by a first purchase names that purchase (lead note N7).
ALTER TABLE "PersonBilling" ADD CONSTRAINT "PersonBilling_firstPurchaseRef_check"
    CHECK ("fixedBy" <> 'first_purchase' OR "purchaseRef" IS NOT NULL);
