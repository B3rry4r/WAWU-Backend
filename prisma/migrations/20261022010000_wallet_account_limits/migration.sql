-- WALLET-23: the account's limit as the wallet provider reports it. Additive
-- only: three nullable columns on "FintavaWallet", written on every balance
-- read. Existing rows read null (no limit known yet). The Hub's own limits
-- are untouched.
-- Rollback: ALTER TABLE "FintavaWallet" DROP COLUMN "accountTier", DROP COLUMN "dailyLimitKobo", DROP COLUMN "limitsReadAt";

-- AlterTable
ALTER TABLE "FintavaWallet" ADD COLUMN     "accountTier" TEXT,
ADD COLUMN     "dailyLimitKobo" BIGINT,
ADD COLUMN     "limitsReadAt" TIMESTAMP(3);
