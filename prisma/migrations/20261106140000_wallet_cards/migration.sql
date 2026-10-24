-- WALLET-31 (R-84): the WAWU card on Nuvion. Additive only: one new table, and
-- three values in each of the two admin audit enums for support freezing,
-- unfreezing and blocking a person's card. The table keeps whose card it is,
-- its kind, state and Nuvion's id; never the card number, expiry, CVV or
-- billing address (read from Nuvion behind the PIN each time).
-- Rollback: rollback.sql beside this file (it refuses to drop the table while
-- it holds a card that is not failed). The enum values cannot be dropped in
-- Postgres without recreating the types: they are unused when rolled back and
-- are left in place.

-- AlterEnum
ALTER TYPE "AdminOpsResource" ADD VALUE 'wallet_card';

-- AlterEnum
ALTER TYPE "AdminOpsAction" ADD VALUE 'wallet_card_frozen';
ALTER TYPE "AdminOpsAction" ADD VALUE 'wallet_card_unfrozen';
ALTER TYPE "AdminOpsAction" ADD VALUE 'wallet_card_cancelled';

-- CreateTable
CREATE TABLE "WalletCard" (
    "id" TEXT NOT NULL,
    "wawuUserId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerCardId" TEXT,
    "reference" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "state" TEXT NOT NULL,
    "frozenBy" TEXT,
    "providerFeeKobo" BIGINT,
    "wawuFeeKobo" BIGINT NOT NULL DEFAULT 0,
    "failure" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WalletCard_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WalletCard_providerCardId_key" ON "WalletCard"("providerCardId");

-- CreateIndex
CREATE UNIQUE INDEX "WalletCard_reference_key" ON "WalletCard"("reference");

-- CreateIndex
CREATE INDEX "WalletCard_wawuUserId_state_idx" ON "WalletCard"("wawuUserId", "state");

-- CreateIndex
CREATE INDEX "WalletCard_state_createdAt_idx" ON "WalletCard"("state", "createdAt");
