-- A credit pack bought from the wallet (task INBOX-16).
--
-- Additive only: one new nullable column and its unique index on an existing
-- table. No existing column, row or index changes, and the web's Flutterwave
-- purchase (POST /credits/purchase and /verify) never reads or writes it. The
-- column holds the id of the wallet payment that bought the pack, so one
-- payment settles at most one purchase.
--
-- Rollback:
--   DROP INDEX "CreditPurchase_walletPaymentId_key";
--   ALTER TABLE "CreditPurchase" DROP COLUMN "walletPaymentId";

-- AlterTable
ALTER TABLE "CreditPurchase" ADD COLUMN "walletPaymentId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "CreditPurchase_walletPaymentId_key" ON "CreditPurchase"("walletPaymentId");
