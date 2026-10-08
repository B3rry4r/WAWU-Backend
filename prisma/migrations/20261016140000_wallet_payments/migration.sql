-- Pay from wallet (task MONEY-17).
--
-- Additive only: two new tables and two columns on "TransactionPin" (one
-- with a default, one nullable). No existing column, index or row changes
-- meaning. Never deployed: the two folders MONEY-17 had
-- (20261004140800_wallet_payments, 20261004140900_transaction_pin_inflight)
-- are this one, restamped after every folder on main (8 Oct 2026) when the
-- payment moved onto the wallet provider seam (MONEY-20).
--
-- MoneyIdempotencyKey: one row per (person, method, route, Idempotency-Key),
-- the primary key is the lock; the stored answer of a money-moving request,
-- sent again to a repeat (docs/contract/CONVENTIONS.md section 4).
-- WalletPayment: one row per payment from a wallet to WAWU's own account at
-- the wallet provider, with the 85/15 split of the price; every figure
-- BIGINT kobo. `openKey` is unique: one open payment per buyer and item.
-- `provider` names the provider that took it (WALLET_PROVIDER at the time).
-- "TransactionPin"."pendingTries": checks that took a slot and have not
-- finished. A check takes a slot in one conditional UPDATE (failedTries +
-- pendingTries below the limit), compares the PIN with no transaction and no
-- row lock open, and gives the slot back in one more UPDATE.
-- "pendingSince": when the newest slot was taken, so a slot left by a check
-- that died counts as free after 30 seconds.
--
-- Rollback: DROP TABLE "WalletPayment"; DROP TABLE "MoneyIdempotencyKey";
-- ALTER TABLE "TransactionPin" DROP COLUMN "pendingSince", DROP COLUMN "pendingTries";

-- CreateTable
CREATE TABLE "MoneyIdempotencyKey" (
    "wawuUserId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "claimId" TEXT,
    "resourceId" TEXT,
    "responseStatus" INTEGER,
    "responseBody" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MoneyIdempotencyKey_pkey" PRIMARY KEY ("wawuUserId","method","route","key")
);

-- CreateTable
CREATE TABLE "WalletPayment" (
    "id" TEXT NOT NULL,
    "payerWawuUserId" TEXT,
    "kind" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "payeeWawuUserId" TEXT,
    "priceKobo" BIGINT NOT NULL,
    "providerFeeKobo" BIGINT NOT NULL,
    "wawuFeeKobo" BIGINT NOT NULL,
    "totalKobo" BIGINT NOT NULL,
    "payeeShareKobo" BIGINT NOT NULL,
    "wawuShareKobo" BIGINT NOT NULL,
    "payeeSettledAt" TIMESTAMP(3),
    "customerReference" TEXT NOT NULL,
    "payerAccountNumber" TEXT,
    "merchantAccountNumber" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'fintava',
    "status" TEXT NOT NULL,
    "openKey" TEXT,
    "nextCheckAt" TIMESTAMP(3),
    "checks" INTEGER NOT NULL DEFAULT 0,
    "reviewSince" TIMESTAMP(3),
    "failureReason" TEXT,
    "discrepancy" TEXT,
    "note" TEXT,
    "sentAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "fulfilledAt" TIMESTAMP(3),
    "deliveryAttempts" INTEGER NOT NULL DEFAULT 0,
    "nextDeliveryAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WalletPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MoneyIdempotencyKey_updatedAt_idx" ON "MoneyIdempotencyKey"("updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WalletPayment_customerReference_key" ON "WalletPayment"("customerReference");

-- CreateIndex
CREATE UNIQUE INDEX "WalletPayment_openKey_key" ON "WalletPayment"("openKey");

-- CreateIndex
CREATE INDEX "WalletPayment_payerWawuUserId_createdAt_idx" ON "WalletPayment"("payerWawuUserId", "createdAt");

-- CreateIndex
CREATE INDEX "WalletPayment_status_createdAt_idx" ON "WalletPayment"("status", "createdAt");

-- CreateIndex
CREATE INDEX "WalletPayment_kind_targetId_idx" ON "WalletPayment"("kind", "targetId");

-- CreateIndex
CREATE INDEX "WalletPayment_status_reviewSince_nextCheckAt_id_idx" ON "WalletPayment"("status", "reviewSince", "nextCheckAt", "id");

-- CreateIndex
CREATE INDEX "WalletPayment_status_fulfilledAt_reviewSince_nextDeliveryAt_idx" ON "WalletPayment"("status", "fulfilledAt", "reviewSince", "nextDeliveryAt");

-- AlterTable
ALTER TABLE "TransactionPin" ADD COLUMN     "pendingSince" TIMESTAMP(3),
ADD COLUMN     "pendingTries" INTEGER NOT NULL DEFAULT 0;
