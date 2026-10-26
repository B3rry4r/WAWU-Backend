\set ON_ERROR_STOP on
-- Rollback of 20261204090000_tier_yearly (TIER-YEARLY, R-89). Run it only after the Hub build that holds the
-- yearly figures in src/plans/plans.config.json is gone. Run with: psql -1 -f rollback.sql
-- The migration changed no structure; it set the saved admin settings of the tiers' price and length. Their old
-- values cannot be told from the new ones afterwards (the migration printed each as a NOTICE when it ran), so this
-- refuses, and changes nothing, while any of the six rows exists. Reset them on purpose first, in admin settings
-- or by deleting the rows, after a person has decided what each should read (a row deleted reads the default of
-- the build that runs):
--   DELETE FROM "PlanSetting" WHERE "key" IN ('plan.tier.verify.price_kobo', 'plan.tier.verify.days',
--     'plan.tier.plus.price_kobo', 'plan.tier.plus.days', 'plan.tier.founding.price_kobo', 'plan.tier.founding.days');
-- With none of the six rows there is nothing to restore: the figures come from the seed, which goes back with the build.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "PlanSetting"
    WHERE "key" IN (
      'plan.tier.verify.price_kobo', 'plan.tier.verify.days',
      'plan.tier.plus.price_kobo', 'plan.tier.plus.days',
      'plan.tier.founding.price_kobo', 'plan.tier.founding.days'
    )
  ) THEN
    RAISE EXCEPTION 'TIER-YEARLY rollback: a saved setting of a tier price or length exists and its old value is gone. Nothing was changed.';
  END IF;
END $$;
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261204090000_tier_yearly';
