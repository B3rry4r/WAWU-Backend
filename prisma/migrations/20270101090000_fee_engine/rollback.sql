\set ON_ERROR_STOP on
-- Rollback of 20270101090000_fee_engine (FEE-01, R-139). Run with: psql -1 -f rollback.sql, only after the Hub build
-- that reads these tables is gone.
--
-- It refuses (changing nothing) while there is anything it would lose: any "FeeSchedule" or "ProviderRate" row that is
-- not a seed row, any "MoneyFeeRecord" row, or an admin-changed fee. Those are the owner's history and the money
-- record; export them first (COPY ... TO) and delete them on purpose, with the append-only triggers dropped by hand.
-- The seed rows alone are dropped with their tables. It does not restore "fx.product.swap.on": the old value of the
-- saved row is not recoverable from the row; set it back in admin settings if swaps should be on.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "FeeSchedule" WHERE "changedBy" <> 'R-139 seed') THEN
    RAISE EXCEPTION 'FeeSchedule holds fee changes made after the seed; export them first';
  END IF;
  IF EXISTS (SELECT 1 FROM "ProviderRate" WHERE "changedBy" <> 'R-139 seed') THEN
    RAISE EXCEPTION 'ProviderRate holds rate changes made after the seed; export them first';
  END IF;
  IF EXISTS (SELECT 1 FROM "MoneyFeeRecord") THEN
    RAISE EXCEPTION 'MoneyFeeRecord holds fee records; export them first';
  END IF;
END $$;

DROP TRIGGER "FeeSchedule_no_truncate" ON "FeeSchedule";
DROP TRIGGER "ProviderRate_no_truncate" ON "ProviderRate";
DROP FUNCTION "fee_history_no_truncate"();
DROP TRIGGER "FeeSchedule_append_only" ON "FeeSchedule";
DROP TRIGGER "ProviderRate_append_only" ON "ProviderRate";
DROP FUNCTION "fee_history_append_only"();
DROP TABLE "FeeAlertSent";
DROP TABLE "MoneyFeeRecord";
DROP TABLE "ProviderRate";
DROP TABLE "FeeSchedule";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20270101090000_fee_engine';
