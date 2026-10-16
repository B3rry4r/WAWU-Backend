-- Send money to a WAWU user (task WALLET-07).
--
-- Additive only: one new table. No existing column, index or row changes
-- meaning.
--
-- WalletTransfer: one row per send from one person's wallet to another WAWU
-- user's, one wallet-to-wallet transfer at the wallet provider under our
-- reference "wawu-send-<id>". Every figure is BIGINT kobo. The ledger rows of
-- the movement carry the row's id as "transferId" (a column that already
-- exists on "FintavaLedgerEntry"). "provider" names the provider that took
-- the send (WALLET_PROVIDER at the time); "debitReviewSince" flags a debit
-- above the quoted total for review.
--
-- Rollback: DROP TABLE "WalletTransfer";

-- CreateTable
CREATE TABLE "WalletTransfer" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'wawu_user',
    "payerWawuUserId" TEXT,
    "recipientWawuUserId" TEXT,
    "payerName" TEXT,
    "recipientName" TEXT,
    "amountKobo" BIGINT NOT NULL,
    "providerFeeKobo" BIGINT NOT NULL,
    "wawuFeeKobo" BIGINT NOT NULL,
    "totalKobo" BIGINT NOT NULL,
    "note" TEXT,
    "customerReference" TEXT NOT NULL,
    "payerAccountNumber" TEXT,
    "recipientAccountNumber" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'fintava',
    "status" TEXT NOT NULL,
    "nextCheckAt" TIMESTAMP(3),
    "checks" INTEGER NOT NULL DEFAULT 0,
    "reviewSince" TIMESTAMP(3),
    "failureReason" TEXT,
    "discrepancy" TEXT,
    "debitReviewSince" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "reversedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WalletTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WalletTransfer_customerReference_key" ON "WalletTransfer"("customerReference");

-- CreateIndex
CREATE INDEX "WalletTransfer_payerWawuUserId_createdAt_idx" ON "WalletTransfer"("payerWawuUserId", "createdAt");

-- CreateIndex
CREATE INDEX "WalletTransfer_recipientWawuUserId_createdAt_idx" ON "WalletTransfer"("recipientWawuUserId", "createdAt");

-- CreateIndex
CREATE INDEX "WalletTransfer_status_reviewSince_nextCheckAt_id_idx" ON "WalletTransfer"("status", "reviewSince", "nextCheckAt", "id");
