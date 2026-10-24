\set ON_ERROR_STOP on
-- Rollback of 20261114093000_wallet_card_fee_collected (WALLET-31 round 1).
-- Drops the one column and nothing else. Run with: psql -1 -f rollback.sql
-- Refuses (and changes nothing) while a card holds a fee that was asked for and
-- not yet collected, or one that was collected (the column is the only WAWU
-- record of it): collect or write off the fee first, then roll back.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "WalletCard"
     WHERE "wawuFeeKobo" > 0 AND "state" <> 'failed'
  ) THEN
    RAISE EXCEPTION 'WALLET-31 round 1 rollback: a card carries a WAWU fee (owed or collected). Nothing was changed.';
  END IF;
END $$;
ALTER TABLE "WalletCard" DROP COLUMN "feeCollectedAt";
