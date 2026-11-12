\set ON_ERROR_STOP on
-- Rollback of 20270101100000_card_issue_fee (FEE-07, R-140). Run with: psql -1 -f rollback.sql, only after the Hub build
-- that reads the "card_issue" fee is gone.
--
-- It refuses (changing nothing) while there is anything it would lose: any "card_issue" row in "FeeSchedule" that is
-- not the seed row (an admin changed the card fee), or any "MoneyFeeRecord" of kind "card_issue". Those are the
-- owner's history and the money record; export them first (COPY ... TO). The seed row alone is removed: the history
-- table refuses DELETE, so this switches its append-only trigger off for that one delete inside the same transaction
-- and switches it back on before it ends.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "FeeSchedule" WHERE "kind" = 'card_issue' AND "changedBy" <> 'R-140 seed') THEN
    RAISE EXCEPTION 'FeeSchedule holds card fee changes made after the seed; export them first';
  END IF;
  IF EXISTS (SELECT 1 FROM "MoneyFeeRecord" WHERE "kind" = 'card_issue') THEN
    RAISE EXCEPTION 'MoneyFeeRecord holds card fee records; export them first';
  END IF;
END $$;

ALTER TABLE "FeeSchedule" DISABLE TRIGGER "FeeSchedule_append_only";
DELETE FROM "FeeSchedule" WHERE "kind" = 'card_issue' AND "changedBy" = 'R-140 seed';
ALTER TABLE "FeeSchedule" ENABLE TRIGGER "FeeSchedule_append_only";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20270101100000_card_issue_fee';
