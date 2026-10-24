\set ON_ERROR_STOP on
-- Rollback of 20261130090000_abroad_foreign_fee (WALLET-42). Run it only after the Hub build that reads these columns is gone.
-- Run with: psql -1 -f rollback.sql
-- Refuses (and changes nothing) while any send holds a fee in a foreign currency: dropping the column would lose the only record of
-- what WAWU took from, or still owes back to, a person's foreign account. Quotes are short-lived and are dropped with it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "AbroadSend" WHERE "wawuFeeMinor" > 0) THEN
    RAISE EXCEPTION 'WALLET-42 rollback: sends hold a fee taken from a foreign account and would lose it. Nothing was changed.';
  END IF;
END $$;
ALTER TABLE "AbroadSend" DROP COLUMN "wawuFeeMinor";
ALTER TABLE "AbroadQuote" DROP COLUMN "wawuFeeMinor";
