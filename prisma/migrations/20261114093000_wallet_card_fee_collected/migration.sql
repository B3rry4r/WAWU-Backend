-- WALLET-31 fix round 1 (M1): WAWU's own fee on a card is collected like WAWU's
-- fee on a send, after the card exists, and retried until it lands. Additive
-- only: one nullable column on WalletCard, the time the fee's transfer was
-- confirmed (null while it is owed, or when the fee is 0).
-- Rollback: rollback.sql beside this file (it refuses while a fee is owed).

-- AlterTable
ALTER TABLE "WalletCard" ADD COLUMN "feeCollectedAt" TIMESTAMP(3);
