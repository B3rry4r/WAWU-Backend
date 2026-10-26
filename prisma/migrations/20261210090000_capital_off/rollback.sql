\set ON_ERROR_STOP on
-- Rollback of 20261210090000_capital_off (CAPITAL-OFF, R-97). Run it only after the Hub build that holds the default of 0
-- in src/plan-settings/plan-settings.defaults.json is gone. Run with: psql -1 -f rollback.sql
-- The migration changed no structure; it set the saved admin setting `capital.enabled` to 0. The old value of that row
-- cannot be told from an admin's own 0 afterwards (the migration printed it as a NOTICE when it ran), so this refuses, and
-- changes nothing, while the row exists. Reset it on purpose first, in admin settings or by deleting the row, after a person
-- has decided what it should read (a row deleted reads the default of the build that runs, which is on before R-97):
--   DELETE FROM "PlanSetting" WHERE "key" = 'capital.enabled';
-- With no row there is nothing to restore: the switch comes from the default, which goes back with the build.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "PlanSetting" WHERE "key" = 'capital.enabled') THEN
    RAISE EXCEPTION 'CAPITAL-OFF rollback: a saved setting capital.enabled exists and its old value is gone. Nothing was changed.';
  END IF;
END $$;
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261210090000_capital_off';
