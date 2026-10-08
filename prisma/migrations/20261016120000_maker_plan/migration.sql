-- TIER-01: the maker plan's state (R-43). A person's billing currency, the
-- tier they hold and the event passes their tiers issued. Prices, product
-- counts and points are NOT here: they live in src/plans/plans.config.json.
--
-- Additive: one new enum and three new tables. No existing table, column,
-- index or row is touched, and no relation is added to an existing model, so
-- no live response gains a key (protected route registry, H-1).
--
-- Rollback:
--   DROP TABLE "EventPass", "MakerTier", "PersonBilling";
--   DROP TYPE "BillingCurrency";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261016120000_maker_plan';

-- CreateEnum
CREATE TYPE "BillingCurrency" AS ENUM ('NGN', 'USD');

-- CreateTable
CREATE TABLE "PersonBilling" (
    "wawuUserId" TEXT NOT NULL,
    "currency" "BillingCurrency" NOT NULL,
    "fixedBy" TEXT NOT NULL,
    "purchaseRef" TEXT,
    "fixedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PersonBilling_pkey" PRIMARY KEY ("wawuUserId"),
    CONSTRAINT "PersonBilling_fixedBy_check" CHECK ("fixedBy" IN ('first_purchase', 'support'))
);

-- CreateTable
CREATE TABLE "MakerTier" (
    "wawuUserId" TEXT NOT NULL,
    "tierId" TEXT NOT NULL,
    "activeFrom" TIMESTAMP(3) NOT NULL,
    "activeUntil" TIMESTAMP(3) NOT NULL,
    "productsIncluded" INTEGER NOT NULL,
    "extraProducts" INTEGER NOT NULL DEFAULT 0,
    "pointsIncluded" INTEGER NOT NULL,
    "voiceIntroIncluded" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MakerTier_pkey" PRIMARY KEY ("wawuUserId"),
    CONSTRAINT "MakerTier_tierId_check" CHECK (length("tierId") > 0),
    CONSTRAINT "MakerTier_period_check" CHECK ("activeUntil" > "activeFrom"),
    CONSTRAINT "MakerTier_productsIncluded_check" CHECK ("productsIncluded" >= 0),
    CONSTRAINT "MakerTier_extraProducts_check" CHECK ("extraProducts" >= 0),
    CONSTRAINT "MakerTier_pointsIncluded_check" CHECK ("pointsIncluded" >= 0)
);

-- CreateTable
CREATE TABLE "EventPass" (
    "id" TEXT NOT NULL,
    "wawuUserId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "purchaseRef" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventPass_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EventPass_type_check" CHECK (length("type") > 0)
);

-- CreateIndex
CREATE UNIQUE INDEX "EventPass_purchaseRef_key" ON "EventPass"("purchaseRef");

-- CreateIndex
CREATE INDEX "EventPass_wawuUserId_idx" ON "EventPass"("wawuUserId");
