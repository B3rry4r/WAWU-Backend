-- STORE-BUY-HUB round 5 (R4-1). Additive: one nullable column and an index on "StorePurchase"; nothing the web or the
-- dashboard calls reads it.
--
-- A ladder purchase paid with a store credit now carries the origin of that credit ("creditOriginId": the store purchase
-- whose payment the credit is made of). The link used to live only on "StoreCredit", which the account purge deletes with
-- the fan's account while the purchase is kept; a store refund of the origin could then no longer find the sale the credit
-- had paid for, and the creator's share stayed. Existing rows are filled from their credit below.
--
-- Rollback: rollback.sql in this folder. It refuses while any purchase has an origin whose credit row is gone, because
-- that link would be lost.

ALTER TABLE "StorePurchase" ADD COLUMN "creditOriginId" TEXT;
CREATE INDEX "StorePurchase_creditOriginId_idx" ON "StorePurchase"("creditOriginId");

UPDATE "StorePurchase" p
   SET "creditOriginId" = COALESCE(c."originPurchaseId", c."sourcePurchaseId")
  FROM "StoreCredit" c
 WHERE c."spentPurchaseId" = p."id" AND p."creditOriginId" IS NULL;
