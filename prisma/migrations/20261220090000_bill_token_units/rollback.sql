\set ON_ERROR_STOP on
-- Rollback for 20261220090000_bill_token_units (BILLS-09). It refuses while any bill holds a token or units: a token is
-- what the person paid for, it cannot be read back from anywhere else, and dropping the column would lose it. Hand the
-- tokens to the people who own them (or decide to drop them) first. "providerCheckedAt" is a timestamp only and goes
-- with them.
-- Run with: psql -1 -f rollback.sql
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "BillPayment" WHERE "token" IS NOT NULL OR "units" IS NOT NULL) THEN
    RAISE EXCEPTION 'BILLS-09 rollback refused: a bill holds a token or units. Nothing was changed.';
  END IF;
END $$;

ALTER TABLE "BillPayment" DROP COLUMN "token", DROP COLUMN "units", DROP COLUMN "providerCheckedAt";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261220090000_bill_token_units';
