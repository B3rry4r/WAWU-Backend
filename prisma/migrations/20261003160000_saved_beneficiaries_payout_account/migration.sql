-- Saved beneficiaries and the payout account (task WALLET-14).
--
-- Additive only: two new tables and one nullable column on the table KYC-01
-- added (20261002200000_wallet_identity). No existing column, index or row is
-- touched; every existing WalletIdentity row reads bvnNameKeys as null, which
-- the payout account answers as "no BVN name to compare with".
--
-- bvnNameKeys holds keyed hashes (HMAC-SHA256 under IDENTITY_HASH_KEY) of the
-- words of the BVN record's first and last name, never the name itself.
--
-- Rollback: DROP TABLE "MoneyPayoutAccount"; DROP TABLE "MoneyBeneficiary"; ALTER TABLE "WalletIdentity" DROP COLUMN "bvnNameKeys";

-- AlterTable
ALTER TABLE "WalletIdentity" ADD COLUMN     "bvnNameKeys" JSONB;

-- CreateTable
CREATE TABLE "MoneyBeneficiary" (
    "id" TEXT NOT NULL,
    "ownerWawuId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "recipientWawuId" TEXT,
    "bankCode" TEXT,
    "bankName" TEXT,
    "accountNumber" TEXT,
    "accountName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MoneyBeneficiary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MoneyPayoutAccount" (
    "wawuUserId" TEXT NOT NULL,
    "bankCode" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MoneyPayoutAccount_pkey" PRIMARY KEY ("wawuUserId")
);

-- CreateIndex
CREATE INDEX "MoneyBeneficiary_ownerWawuId_createdAt_idx" ON "MoneyBeneficiary"("ownerWawuId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MoneyBeneficiary_ownerWawuId_recipientWawuId_key" ON "MoneyBeneficiary"("ownerWawuId", "recipientWawuId");

-- CreateIndex
CREATE UNIQUE INDEX "MoneyBeneficiary_ownerWawuId_bankCode_accountNumber_key" ON "MoneyBeneficiary"("ownerWawuId", "bankCode", "accountNumber");
