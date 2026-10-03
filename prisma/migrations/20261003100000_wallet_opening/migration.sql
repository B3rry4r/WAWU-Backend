-- Opening a person's Fintava account (task MONEY-12).
--
-- Additive only: one new table, and one nullable column on the table MONEY-11
-- added (20261002180000_fintava_wallet). No existing column, index or row is
-- touched; every existing FintavaWallet row reads accountName as null.
--
-- FintavaWalletOpening is the record that makes opening safe to retry: its
-- primary key is the per-person claim, and its unique BVN hash and phone stop
-- a second WAWU account opening a second Fintava account for the same person.
-- It holds the keyed hash of the BVN (as WalletIdentity does) and the proved
-- phone; never the BVN, the NIN, the name, the date of birth or the address.
--
-- Rollback: DROP TABLE "FintavaWalletOpening"; ALTER TABLE "FintavaWallet" DROP COLUMN "accountName";

-- AlterTable
ALTER TABLE "FintavaWallet" ADD COLUMN "accountName" TEXT;

-- CreateTable
CREATE TABLE "FintavaWalletOpening" (
    "wawuUserId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'opening',
    "bvnHash" TEXT NOT NULL,
    "bvnVerifiedAt" TIMESTAMP(3) NOT NULL,
    "phone" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "attemptStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "failure" TEXT,
    "checkedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FintavaWalletOpening_pkey" PRIMARY KEY ("wawuUserId")
);

-- CreateIndex
CREATE UNIQUE INDEX "FintavaWalletOpening_bvnHash_key" ON "FintavaWalletOpening"("bvnHash");

-- CreateIndex
CREATE UNIQUE INDEX "FintavaWalletOpening_phone_key" ON "FintavaWalletOpening"("phone");

-- CreateIndex
CREATE INDEX "FintavaWalletOpening_state_attemptStartedAt_idx" ON "FintavaWalletOpening"("state", "attemptStartedAt");
