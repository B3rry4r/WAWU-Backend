-- STORE-BUY-HUB round 4 (R-101). Additive: one nullable column on "StoreCredit" (a table made in 20261214090000), read by
-- nothing the web or the dashboard calls.
--
-- "originPurchaseId" is the store purchase whose payment a credit is made of. For every credit that exists it is its own
-- "sourcePurchaseId" (written below). The rest of a larger credit, left after part of it paid for something, is a new open
-- credit with the same origin, so that a store refund of the origin takes back everything its payment made.
--
-- Rollback: rollback.sql in this folder. It refuses while a credit made of the rest of another exists, because dropping
-- the column would lose which purchase it came from.

ALTER TABLE "StoreCredit" ADD COLUMN "originPurchaseId" TEXT;
UPDATE "StoreCredit" SET "originPurchaseId" = "sourcePurchaseId" WHERE "originPurchaseId" IS NULL;
CREATE INDEX "StoreCredit_originPurchaseId_idx" ON "StoreCredit"("originPurchaseId");
