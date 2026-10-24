\set ON_ERROR_STOP on
-- Rollback of 20261112090000_fx_accounts (WALLET-21). Drops the five tables the
-- migration made and nothing else. Run with: psql -1 -f rollback.sql
-- Refuses (and changes nothing) while ANY of them holds a row: an account row
-- is the only link between a person and the account Nuvion holds for them,
-- an operation or a movement is the record of money that moved, and an audit
-- row is the record of an admin's act. Dropping them would lose those. Copy
-- them out first only if you mean to lose them.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "FxAccount")
     OR EXISTS (SELECT 1 FROM "FxQuote")
     OR EXISTS (SELECT 1 FROM "FxOperation")
     OR EXISTS (SELECT 1 FROM "FxMovement")
     OR EXISTS (SELECT 1 FROM "FxAdminAudit")
  THEN
    RAISE EXCEPTION 'WALLET-21 rollback: foreign accounts, quotes, swaps, sends, movements or audit rows exist. Nothing was changed.';
  END IF;
END $$;
DROP TABLE "FxAdminAudit";
DROP TABLE "FxMovement";
DROP TABLE "FxOperation";
DROP TABLE "FxQuote";
DROP TABLE "FxAccount";
