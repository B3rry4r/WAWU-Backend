-- NUVION-FIX (Nuvion's answers, 27 Oct 2026). Three things, all additive:
--
-- 1. Item 1.1. Nuvion takes no naira by card, mobile money or open banking, and card acquiring is SUSPENDED in production. The two
--    plan settings `money.add_money_card_on` and `money.add_money_ussd_on` now default to 0 in the Hub's code
--    (src/plan-settings/plan-settings.defaults.json and the registry), so a database with no saved row follows the moment this build
--    runs. This file is for the other case: an admin saved either as on, and that row would keep the rail open over the answer.
--    It sets such a row to 0 and keeps what it was (the value and the admin) in "PlanSettingNuvionFixBackup", so rollback.sql can put
--    it back. A key with no row is left alone (its default already is off); a row already at 0 is not touched and keeps no backup.
--
-- 2. Items 9.5 and 9.6. Two nullable markers on "FxAccount": "detailsAskedAt" (the Hub asks the provider to make an account's details at
--    most every 5 minutes) and "detailsReadyAt" (the person is told the details are ready once). No existing row changes: null means
--    "not yet", which is exactly what every existing account is.
--
-- Nothing a person holds is changed: no order, balance, ledger row, sweep or account. No existing column is renamed, retyped or
-- widened. Safe to run again: the table and columns are IF NOT EXISTS, the backup keeps the first value it was given, and the update
-- sets a literal. Rollback: rollback.sql (puts the old values back, and refuses while an admin has set a row since).

CREATE TABLE IF NOT EXISTS "PlanSettingNuvionFixBackup" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedByAdminId" TEXT,
    "savedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlanSettingNuvionFixBackup_pkey" PRIMARY KEY ("key")
);

INSERT INTO "PlanSettingNuvionFixBackup" ("key", "value", "updatedByAdminId")
  SELECT "key", "value", "updatedByAdminId" FROM "PlanSetting"
   WHERE "key" IN ('money.add_money_card_on', 'money.add_money_ussd_on')
     AND "value" IS DISTINCT FROM to_jsonb(0)
  ON CONFLICT ("key") DO NOTHING;

UPDATE "PlanSetting" SET "value" = to_jsonb(0), "updatedByAdminId" = NULL, "updatedAt" = now()
  WHERE "key" IN ('money.add_money_card_on', 'money.add_money_ussd_on') AND "value" IS DISTINCT FROM to_jsonb(0);

ALTER TABLE "FxAccount" ADD COLUMN IF NOT EXISTS "detailsAskedAt" TIMESTAMP(3);
ALTER TABLE "FxAccount" ADD COLUMN IF NOT EXISTS "detailsReadyAt" TIMESTAMP(3);
