\set ON_ERROR_STOP on
-- Rollback of 20261113100000_capital_orders (NUV-12). Run it only after the Hub build that reads these tables is gone.
-- Run with: psql -1 -f rollback.sql
-- Refuses (and changes nothing) while any order is past its reservation: a confirmed order is money invested at the
-- provider, and dropping the row loses the link between the person and the holding (and the ledger rows that name it).
-- Reservations that were never confirmed hold no money and may go. To roll back with confirmed orders, export them first
-- and delete them on purpose:
--   DELETE FROM "CapitalOrder" WHERE "state" IN ('confirming', 'confirmed', 'review');
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "CapitalOrder" WHERE "state" IN ('confirming', 'confirmed', 'review')) THEN
    RAISE EXCEPTION 'NUV-12 rollback: confirmed Capital orders are stored and would lose their link to the provider holding. Nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM "CapitalAdminAudit") THEN
    RAISE EXCEPTION 'NUV-12 rollback: admin acts on Capital orders are stored and would be lost. Nothing was changed.';
  END IF;
END $$;
DROP TABLE "CapitalAdminAudit";
DROP TABLE "CapitalOrder";
