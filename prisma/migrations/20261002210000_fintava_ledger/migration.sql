-- The ledger (task MONEY-10).
--
-- Additive only: five new enums and two new tables, nothing else. WAWU's own
-- record of every movement of money on a Fintava wallet it knows, in integer
-- kobo (BIGINT). It is never a balance: the balance is Fintava's (MONEY-11).
--
-- Exactly once: every reference a movement is known by is a row of
-- "FintavaLedgerReference" keyed on (accountNumber, direction, value). A
-- second sighting of the same movement on the same side collides on that key
-- and is merged into the first row (src/money/ledger/ledger.service.ts).
--
-- `prisma migrate diff` also proposes dropping "ContentPiece_specializations_idx".
-- That index predates this task (schema drift, not ours) and is left alone.
-- CreateEnum
CREATE TYPE "FintavaLedgerWallet" AS ENUM ('user', 'merchant');

-- CreateEnum
CREATE TYPE "FintavaLedgerDirection" AS ENUM ('in', 'out');

-- CreateEnum
CREATE TYPE "FintavaLedgerStatus" AS ENUM ('pending', 'completed', 'failed', 'reversed');

-- CreateEnum
CREATE TYPE "FintavaLedgerCategory" AS ENUM ('transfer', 'top_up', 'earning', 'purchase', 'bill', 'hold', 'refund', 'reversal');

-- CreateEnum
CREATE TYPE "FintavaLedgerCounterpartyKind" AS ENUM ('wawu_user', 'bank_account', 'biller', 'wawu');

-- CreateTable
CREATE TABLE "FintavaLedgerEntry" (
    "id" TEXT NOT NULL,
    "walletKind" "FintavaLedgerWallet" NOT NULL,
    "wawuUserId" TEXT,
    "accountNumber" TEXT NOT NULL,
    "direction" "FintavaLedgerDirection" NOT NULL,
    "status" "FintavaLedgerStatus" NOT NULL,
    "category" "FintavaLedgerCategory" NOT NULL,
    "amountKobo" BIGINT NOT NULL,
    "feeKobo" BIGINT NOT NULL DEFAULT 0,
    "providerFeeKobo" BIGINT,
    "wawuFeeKobo" BIGINT,
    "totalKobo" BIGINT NOT NULL,
    "counterpartyKind" "FintavaLedgerCounterpartyKind",
    "counterpartyName" TEXT,
    "counterpartyWawuUserId" TEXT,
    "counterpartyAccountNumber" TEXT,
    "counterpartyBankCode" TEXT,
    "counterpartyBankName" TEXT,
    "linkKind" TEXT,
    "linkTargetId" TEXT,
    "linkTitle" TEXT,
    "note" TEXT,
    "narration" TEXT,
    "customerReference" TEXT,
    "fintavaReference" TEXT,
    "tagapayTransRef" TEXT,
    "fintavaTransactionId" TEXT,
    "sessionId" TEXT,
    "transferId" TEXT,
    "paymentId" TEXT,
    "reversalReference" TEXT,
    "reversalAmountKobo" BIGINT,
    "reversalChargesKobo" BIGINT,
    "reversalTotalKobo" BIGINT,
    "reversedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "discrepancy" TEXT,
    "source" TEXT NOT NULL,
    "sourceEventId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FintavaLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FintavaLedgerReference" (
    "accountNumber" TEXT NOT NULL,
    "direction" "FintavaLedgerDirection" NOT NULL,
    "value" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FintavaLedgerReference_pkey" PRIMARY KEY ("accountNumber","direction","value")
);

-- CreateIndex
CREATE INDEX "FintavaLedgerEntry_wawuUserId_occurredAt_idx" ON "FintavaLedgerEntry"("wawuUserId", "occurredAt");

-- CreateIndex
CREATE INDEX "FintavaLedgerEntry_accountNumber_occurredAt_idx" ON "FintavaLedgerEntry"("accountNumber", "occurredAt");

-- CreateIndex
CREATE INDEX "FintavaLedgerEntry_status_occurredAt_idx" ON "FintavaLedgerEntry"("status", "occurredAt");

-- CreateIndex
CREATE INDEX "FintavaLedgerEntry_customerReference_idx" ON "FintavaLedgerEntry"("customerReference");

-- CreateIndex
CREATE INDEX "FintavaLedgerReference_entryId_idx" ON "FintavaLedgerReference"("entryId");

-- CreateIndex
CREATE INDEX "FintavaLedgerReference_value_idx" ON "FintavaLedgerReference"("value");

-- AddForeignKey
ALTER TABLE "FintavaLedgerReference" ADD CONSTRAINT "FintavaLedgerReference_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "FintavaLedgerEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

