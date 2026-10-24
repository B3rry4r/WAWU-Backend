\set ON_ERROR_STOP on
-- Rollback of 20261128110000_abroad_fee_settled (NUV-11 round 2). Run it only after the Hub build that reads these columns is gone.
-- Run with: psql -1 -f rollback.sql
-- Refuses (and changes nothing) while any send has its fee question closed: dropping the columns would lose the only record that a
-- fee was written off, that finance paid a give-back outside the system, or that nothing was taken, and an account deletion that
-- waits on an open fee would wait again.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "AbroadSend" WHERE "feeSettledAt" IS NOT NULL OR "feeSettledHow" IS NOT NULL) THEN
    RAISE EXCEPTION 'NUV-11 round 2 rollback: sends hold a closed fee question and would lose it. Nothing was changed.';
  END IF;
END $$;
ALTER TABLE "AbroadSend" DROP COLUMN "feeSettledAt", DROP COLUMN "feeSettledHow";
