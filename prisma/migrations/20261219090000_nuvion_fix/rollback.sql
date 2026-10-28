\set ON_ERROR_STOP on
-- Rollback of 20261219090000_nuvion_fix (NUVION-FIX). Run with: psql -1 -f rollback.sql
-- Run it only after the Hub build that holds the add-money switches at 0 by default (src/plan-settings/plan-settings.defaults.json)
-- and the foreign-account details markers is gone.
-- 1. Puts every add-money switch the migration set to 0 back to what it was (the value and the admin), from
--    "PlanSettingNuvionFixBackup". It REFUSES, and changes nothing, while any of those rows now holds something other than 0
--    (an admin set it since: restoring would overwrite their choice). Decide each by hand first (set the row you want, or delete the
--    row, or delete that key from "PlanSettingNuvionFixBackup" to leave it alone), then run this again. A row an admin removed since
--    stays removed.
-- 2. Drops the table and the two nullable markers of "FxAccount". They hold only when the details were last asked for and whether the
--    ready notice was sent: nothing a person owns. Notifications already sent stay: they are history.
-- 3. Forgets the migration so it can run again.
DO $$
DECLARE
  changed integer;
BEGIN
  SELECT count(*) INTO changed FROM "PlanSettingNuvionFixBackup" b
    JOIN "PlanSetting" p ON p."key" = b."key"
   WHERE p."value" IS DISTINCT FROM to_jsonb(0);
  IF changed > 0 THEN
    RAISE EXCEPTION 'NUVION-FIX rollback: % add-money setting(s) were set by an admin since the migration. Nothing was changed.', changed;
  END IF;
END $$;

UPDATE "PlanSetting" p SET "value" = b."value", "updatedByAdminId" = b."updatedByAdminId", "updatedAt" = now()
  FROM "PlanSettingNuvionFixBackup" b WHERE p."key" = b."key" AND p."value" = to_jsonb(0);

DROP TABLE "PlanSettingNuvionFixBackup";
ALTER TABLE "FxAccount" DROP COLUMN IF EXISTS "detailsAskedAt";
ALTER TABLE "FxAccount" DROP COLUMN IF EXISTS "detailsReadyAt";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261219090000_nuvion_fix';
