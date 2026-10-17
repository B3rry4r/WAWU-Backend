-- Sending money to a bank account (task WALLET-09).
--
-- Additive only: five new nullable columns on "WalletTransfer". No existing
-- column, index or row changes meaning; every row already there stays a send
-- to a WAWU user (kind "wawu_user") with these five left null.
--
-- A bank send (kind "bank_account") is the same row as a send between two
-- people: one transfer, one customer reference, one pending ledger row from
-- the claim. What it adds is where the money went (the bank, the account, the
-- holder's name as the bank gave it on the name check just before the send)
-- and when the provider took it ("sentToBankAt", W19's second step).
--
-- Rollback: ALTER TABLE "WalletTransfer"
--   DROP COLUMN "bankCode", DROP COLUMN "bankName",
--   DROP COLUMN "bankAccountNumber", DROP COLUMN "bankAccountName",
--   DROP COLUMN "sentToBankAt";

-- AlterTable
ALTER TABLE "WalletTransfer"
    ADD COLUMN "bankCode" TEXT,
    ADD COLUMN "bankName" TEXT,
    ADD COLUMN "bankAccountNumber" TEXT,
    ADD COLUMN "bankAccountName" TEXT,
    ADD COLUMN "sentToBankAt" TIMESTAMP(3);
