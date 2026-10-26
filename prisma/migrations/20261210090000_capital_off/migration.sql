-- CAPITAL-OFF (R-97, owner, 26 Oct 2026): WAWU offers no investments. Capital (fixed returns and shares, NUV-12) is
-- switched off and no longer shown to anyone who holds nothing in it.
--
-- The default moved in the Hub's code (the plan setting `capital.enabled` is 0 in src/plan-settings/plan-settings.defaults.json
-- and in the registry fallback in src/plan-settings/plan-setting-registry.ts), so a database with no saved row follows the
-- owner's order the moment this build runs. This file is for the other case: an admin saved `capital.enabled` as on
-- (R-84 shipped it on, and an admin may have written the row), and that row would otherwise keep Capital open over the
-- owner's order. Data only: no table, column, index or constraint changes, and no row is added. A key with no row is left
-- alone (its default already is off). A row that already holds 0 is not touched.
--
-- Nothing a person holds is changed: no order, balance, ledger row or sweep. With Capital off the Hub opens no new orders;
-- what a person holds stays readable and withdrawable (the routes for that do not look at this setting).
--
-- The row's old value is written to the server log as a NOTICE (psql shows it) so a rollback can be done by hand if one is
-- ever needed: the old value of the row cannot be recovered from the row afterwards.
--
-- Safe to run again: it sets a literal.

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT "key", "value" FROM "PlanSetting" WHERE "key" = 'capital.enabled'
  LOOP
    RAISE NOTICE 'CAPITAL-OFF: % was %', r."key", r."value";
  END LOOP;
END $$;

UPDATE "PlanSetting" SET "value" = to_jsonb(0), "updatedByAdminId" = NULL, "updatedAt" = now()
  WHERE "key" = 'capital.enabled' AND "value" IS DISTINCT FROM to_jsonb(0);
