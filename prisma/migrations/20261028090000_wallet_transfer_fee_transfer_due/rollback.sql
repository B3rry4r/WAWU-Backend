\set ON_ERROR_STOP on
ALTER TABLE "WalletTransfer" DROP COLUMN "feeTransferDue";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261028090000_wallet_transfer_fee_transfer_due';
