-- IAP-01 fix round 1. Additive only: two new tables and two nullable columns, all on the store tables
-- 20261127100000_store_purchases made. Nothing the web or the dashboard calls reads or writes any of them.
--   StoreSubscription: who holds a store subscription, unique per (platform, subscription key), so a later order
--     of someone else's subscription can never be granted to another person.
--   StoreAccountToken: the stable id a person's store purchases are bound to (never their user id).
--   StorePurchase.flag, flaggedAt: a purchase recorded but not given, for an admin to look at.

ALTER TABLE "StorePurchase" ADD COLUMN "flag" TEXT;
ALTER TABLE "StorePurchase" ADD COLUMN "flaggedAt" TIMESTAMP(3);

CREATE TABLE "StoreSubscription" (
    "id" TEXT NOT NULL,
    "platform" "StorePlatform" NOT NULL,
    "subscriptionKey" TEXT NOT NULL,
    "wawuUserId" TEXT NOT NULL,
    "communityId" TEXT,
    "lapsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoreSubscription_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StoreSubscription_platform_subscriptionKey_key" ON "StoreSubscription"("platform", "subscriptionKey");
CREATE INDEX "StoreSubscription_wawuUserId_communityId_idx" ON "StoreSubscription"("wawuUserId", "communityId");

-- Purchases already recorded: the first purchase of each subscription holds it.
INSERT INTO "StoreSubscription" ("id", "platform", "subscriptionKey", "wawuUserId", "communityId", "createdAt")
SELECT DISTINCT ON ("platform", "subscriptionKey")
       gen_random_uuid()::text, "platform", "subscriptionKey", "wawuUserId", "communityId", "createdAt"
  FROM "StorePurchase"
 WHERE "subscriptionKey" IS NOT NULL
 ORDER BY "platform", "subscriptionKey", "createdAt" ASC, "id" ASC;

CREATE TABLE "StoreAccountToken" (
    "wawuUserId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoreAccountToken_pkey" PRIMARY KEY ("wawuUserId")
);
CREATE UNIQUE INDEX "StoreAccountToken_token_key" ON "StoreAccountToken"("token");
