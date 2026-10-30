\set ON_ERROR_STOP on
-- Rollback of 20261224090000_tier_counts (TIER-COUNTS, R-112). Run it only after the Hub build that holds the new
-- counts (4, 8 and 15) in src/plans/plans.config.json is gone. Run with: psql -1 -f rollback.sql
--
-- What it can restore: nothing in the data. The migration changed no structure, so there is nothing to drop. What
-- it can do is take the migration's record out of "_prisma_migrations", and only when no row is left that it set.
--
-- What it cannot restore, and why it refuses (changing nothing) while a saved setting exists:
--  - The saved admin setting of each tier's products. The old value of a row cannot be told from the new one
--    afterwards (the migration printed each as a NOTICE when it ran), so it refuses while any of the three rows
--    exists. Reset them on purpose first, in admin settings or by deleting the rows, after a person has decided
--    what each should read (a row deleted reads the default of the build that runs):
--      DELETE FROM "PlanSetting" WHERE "key" IN ('plan.tier.verify.products', 'plan.tier.plus.products',
--        'plan.tier.founding.products');
--  - The count on each running tier ("MakerTier"."productsIncluded"). A row raised to 4, 8 or 15 cannot be told
--    from a row that was bought at that count, and a person may already have published into the new places, so
--    these rows are NOT lowered: lowering one would leave a person with more products up than their tier allows,
--    and the old build would then refuse their next publish. They stay as they are; the old build reads the count
--    from the row and so keeps honouring it. To lower one on purpose, a person does it by hand, with the
--    NOTICE lines the migration printed (how many running tiers of each id held which count).
-- With none of the three setting rows there is nothing to restore: the figures come from the seed, which goes
-- back with the build.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "PlanSetting"
    WHERE "key" IN (
      'plan.tier.verify.products', 'plan.tier.plus.products', 'plan.tier.founding.products'
    )
  ) THEN
    RAISE EXCEPTION 'TIER-COUNTS rollback: a saved setting of a tier''s products exists and its old value is gone. Nothing was changed.';
  END IF;
END $$;
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261224090000_tier_counts';
