-- IAP-01 (R-86): points, credits, tiers and community passes bought through Google Play and the App Store.
-- Additive only: one nullable column (CreditPurchase.storePurchaseId, unique), four new tables with three enums,
-- and one widened check (MakerPurchase.method also allows 'store': a tier bought in a store is recorded like a
-- wallet one, so the referral and not-new rules that read MakerPurchase see it). Nothing the web or the dashboard
-- calls reads or writes any of them; every existing row is untouched.

ALTER TABLE "MakerPurchase" DROP CONSTRAINT "MakerPurchase_method_check";
ALTER TABLE "MakerPurchase" ADD CONSTRAINT "MakerPurchase_method_check" CHECK ("method" IN ('wallet', 'store'));

CREATE TYPE "StorePlatform" AS ENUM ('android', 'ios');
CREATE TYPE "StoreProductKind" AS ENUM ('points', 'credits', 'tier', 'pass');
CREATE TYPE "StorePurchaseStatus" AS ENUM ('granted', 'refunded', 'revoked');

ALTER TABLE "CreditPurchase" ADD COLUMN "storePurchaseId" TEXT;
CREATE UNIQUE INDEX "CreditPurchase_storePurchaseId_key" ON "CreditPurchase"("storePurchaseId");

CREATE TABLE "StoreProduct" (
    "id" TEXT NOT NULL,
    "platform" "StorePlatform" NOT NULL,
    "storeProductId" TEXT NOT NULL,
    "kind" "StoreProductKind" NOT NULL,
    "title" TEXT NOT NULL,
    "grants" JSONB NOT NULL,
    "referenceKobo" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreProduct_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StoreProduct_reference_check" CHECK ("referenceKobo" IS NULL OR "referenceKobo" > 0)
);
CREATE UNIQUE INDEX "StoreProduct_platform_storeProductId_key" ON "StoreProduct"("platform", "storeProductId");
CREATE INDEX "StoreProduct_platform_active_sortOrder_idx" ON "StoreProduct"("platform", "active", "sortOrder");

CREATE TABLE "StorePlatformSetting" (
    "platform" "StorePlatform" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "storeFeeBps" INTEGER,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StorePlatformSetting_pkey" PRIMARY KEY ("platform"),
    CONSTRAINT "StorePlatformSetting_fee_check" CHECK ("storeFeeBps" IS NULL OR ("storeFeeBps" >= 0 AND "storeFeeBps" <= 10000))
);

CREATE TABLE "StorePurchase" (
    "id" TEXT NOT NULL,
    "wawuUserId" TEXT NOT NULL,
    "platform" "StorePlatform" NOT NULL,
    "storeTransactionId" TEXT NOT NULL,
    "subscriptionKey" TEXT,
    "productId" TEXT NOT NULL,
    "storeProductId" TEXT NOT NULL,
    "kind" "StoreProductKind" NOT NULL,
    "status" "StorePurchaseStatus" NOT NULL DEFAULT 'granted',
    "environment" TEXT NOT NULL,
    "communityId" TEXT,
    "grant" JSONB NOT NULL,
    "referenceKobo" INTEGER,
    "storeFeeBps" INTEGER NOT NULL,
    "netKobo" INTEGER,
    "creatorWawuUserId" TEXT,
    "creatorShareKobo" INTEGER,
    "currency" TEXT,
    "priceMicros" BIGINT,
    "purchasedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "endReason" TEXT,
    "takenBack" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StorePurchase_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StorePurchase_fee_check" CHECK ("storeFeeBps" >= 0 AND "storeFeeBps" <= 10000),
    CONSTRAINT "StorePurchase_net_check" CHECK ("netKobo" IS NULL OR ("netKobo" >= 0 AND "referenceKobo" IS NOT NULL AND "netKobo" <= "referenceKobo")),
    CONSTRAINT "StorePurchase_share_check" CHECK ("creatorShareKobo" IS NULL OR ("creatorShareKobo" >= 0 AND "netKobo" IS NOT NULL AND "creatorShareKobo" <= "netKobo"))
);
CREATE UNIQUE INDEX "StorePurchase_platform_storeTransactionId_key" ON "StorePurchase"("platform", "storeTransactionId");
CREATE INDEX "StorePurchase_wawuUserId_createdAt_idx" ON "StorePurchase"("wawuUserId", "createdAt");
CREATE INDEX "StorePurchase_platform_subscriptionKey_idx" ON "StorePurchase"("platform", "subscriptionKey");
CREATE INDEX "StorePurchase_status_createdAt_idx" ON "StorePurchase"("status", "createdAt");
CREATE INDEX "StorePurchase_productId_idx" ON "StorePurchase"("productId");
ALTER TABLE "StorePurchase" ADD CONSTRAINT "StorePurchase_productId_fkey" FOREIGN KEY ("productId") REFERENCES "StoreProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "StoreNotification" (
    "id" TEXT NOT NULL,
    "platform" "StorePlatform" NOT NULL,
    "externalId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoreNotification_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StoreNotification_platform_externalId_key" ON "StoreNotification"("platform", "externalId");
CREATE INDEX "StoreNotification_receivedAt_idx" ON "StoreNotification"("receivedAt");
