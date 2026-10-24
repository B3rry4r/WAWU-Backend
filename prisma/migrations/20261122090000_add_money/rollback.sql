\set ON_ERROR_STOP on
-- Rollback of 20261122090000_add_money (WALLET-25, WALLET-26). Drops the two tables and nothing else.
-- Refuses (and changes nothing) while EITHER table holds ANY row: an open attempt may still settle at Nuvion, a credited one is
-- the Hub's link between a ledger row and Nuvion's inflow, and a closed one or an admin's audit row is the record of what was
-- asked and who acted. Nothing is dropped silently. Copy the rows out first only if you mean to lose them.
-- Run with: psql -1 -f rollback.sql
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "AddMoneySession")
     OR EXISTS (SELECT 1 FROM "AddMoneyAudit")
  THEN
    RAISE EXCEPTION 'WALLET-25 rollback: an add-money attempt or an admin audit row exists. Nothing was changed.';
  END IF;
END $$;
DROP TABLE "AddMoneyAudit";
DROP TABLE "AddMoneySession";
