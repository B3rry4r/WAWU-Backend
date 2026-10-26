-- TIER-YEARLY (R-89, owner, 26 Oct 2026, "All yearly"): the three tiers cost Verify 2,999, Verify Plus 5,999
-- and Founding Maker 9,999 naira, and each lasts one year (365 days). They were 1,000 / 30 days, 3,000 / 180 days
-- and 5,000 / 365 days.
--
-- The defaults moved in the seed (src/plans/plans.config.json), so a database with no saved setting follows the
-- new figures the moment this build runs. This file is for the other case: an admin saved one of the six figures
-- (admin settings, TIER-06) and that row would otherwise keep the old figure over the owner's order. Data only:
-- no table, column, index or constraint changes, and no row is added. A key with no row is left alone because
-- its default already is the owner's figure. A row holding the owner's figure already is not touched.
--
-- Only the six keys of the tiers' price and length are set. The tiers' products, bonus points and pack bonus,
-- every other setting, every tier a person already holds (their end date is what they bought) and the store
-- product map (rows an admin typed) are not touched.
--
-- Each row's old value is written to the server log as a NOTICE (psql shows it) so a rollback can be done by
-- hand if one is ever needed: the old value of a row cannot be recovered from the row afterwards.
--
-- The money is kobo: 2,999 naira is 299900. Safe to run again: each statement sets a literal.

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT "key", "value" FROM "PlanSetting"
    WHERE "key" IN (
      'plan.tier.verify.price_kobo', 'plan.tier.verify.days',
      'plan.tier.plus.price_kobo', 'plan.tier.plus.days',
      'plan.tier.founding.price_kobo', 'plan.tier.founding.days'
    )
    ORDER BY "key"
  LOOP
    RAISE NOTICE 'TIER-YEARLY: % was %', r."key", r."value";
  END LOOP;
END $$;

UPDATE "PlanSetting" SET "value" = to_jsonb(299900), "updatedByAdminId" = NULL, "updatedAt" = now()
  WHERE "key" = 'plan.tier.verify.price_kobo' AND "value" IS DISTINCT FROM to_jsonb(299900);
UPDATE "PlanSetting" SET "value" = to_jsonb(365), "updatedByAdminId" = NULL, "updatedAt" = now()
  WHERE "key" = 'plan.tier.verify.days' AND "value" IS DISTINCT FROM to_jsonb(365);
UPDATE "PlanSetting" SET "value" = to_jsonb(599900), "updatedByAdminId" = NULL, "updatedAt" = now()
  WHERE "key" = 'plan.tier.plus.price_kobo' AND "value" IS DISTINCT FROM to_jsonb(599900);
UPDATE "PlanSetting" SET "value" = to_jsonb(365), "updatedByAdminId" = NULL, "updatedAt" = now()
  WHERE "key" = 'plan.tier.plus.days' AND "value" IS DISTINCT FROM to_jsonb(365);
UPDATE "PlanSetting" SET "value" = to_jsonb(999900), "updatedByAdminId" = NULL, "updatedAt" = now()
  WHERE "key" = 'plan.tier.founding.price_kobo' AND "value" IS DISTINCT FROM to_jsonb(999900);
UPDATE "PlanSetting" SET "value" = to_jsonb(365), "updatedByAdminId" = NULL, "updatedAt" = now()
  WHERE "key" = 'plan.tier.founding.days' AND "value" IS DISTINCT FROM to_jsonb(365);
