-- SWEEP-MONEY-5a round 2 (F2): a send records, when it is made, whether a fee transfer
-- was due for it. Nullable, no default, no backfill: sends already stored keep null.
-- Rollback: ALTER TABLE "WalletTransfer" DROP COLUMN "feeTransferDue";

ALTER TABLE "WalletTransfer" ADD COLUMN "feeTransferDue" BOOLEAN;
