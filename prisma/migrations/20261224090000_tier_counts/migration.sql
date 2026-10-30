-- TIER-COUNTS (R-112, owner, 27 Oct 2026): the three tiers each allow more products. Verify allows 4, Verify Plus 8
-- and Founding Maker 15. They allowed 3, 6 and 10. Lead ruling (30 Oct 2026): a person who already holds a running
-- tier gets the new count at once. Only a count goes up; no price, length, bonus points or other figure changes.
--
-- Two kinds of row are moved, and both are data only (no table, column, index or constraint changes, no row added):
--
-- 1. The saved admin setting of each tier's products ("PlanSetting", keys plan.tier.verify.products,
--    plan.tier.plus.products and plan.tier.founding.products). The default moved in the seed
--    (src/plans/plans.config.json), so a database with no saved row follows the owner's figure the moment this build
--    runs. A saved row would keep the old figure over the owner's order, so each row that exists and holds another
--    figure is set to the owner's. A key with no row is left alone (its default already is the owner's figure). A
--    row holding the owner's figure already is not touched. An admin who saves a figure later still wins for every
--    tier bought after that, as before.
--
-- 2. The count each running tier carries ("MakerTier"."productsIncluded", copied onto the row when the tier was
--    bought). A tier whose "activeUntil" is still in the future (active or ending) and whose count is lower than
--    the new count of its tier is raised to it. A count is only ever raised: a row at or above the new count is not
--    touched (an admin may have given a bigger one), and an ended tier is not touched (its end date is what the
--    person bought, and a renewal copies the count of the tier bought then). The extra products a person bought
--    ("extraProducts") are a separate column and stay on top. The tier's id, dates, points and badge are not touched.
--
-- Each saved row's old value, and how many running tiers were raised from which count, are written to the server log
-- as NOTICEs (psql shows them), so a rollback can be done by hand if one is ever needed: the old value of a row
-- cannot be recovered from the row afterwards. No person's id is printed.
--
-- Time: the columns hold UTC without a zone (Prisma writes them so), so "now" is taken as UTC whatever the
-- database session's time zone is.
--
-- Safe to run again: each statement sets a literal and a second run finds nothing left to change.

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT "key", "value" FROM "PlanSetting"
    WHERE "key" IN (
      'plan.tier.verify.products', 'plan.tier.plus.products', 'plan.tier.founding.products'
    )
    ORDER BY "key"
  LOOP
    RAISE NOTICE 'TIER-COUNTS: % was %', r."key", r."value";
  END LOOP;

  FOR r IN
    SELECT "tierId", "productsIncluded", count(*) AS n FROM "MakerTier"
    WHERE "activeUntil" > (now() AT TIME ZONE 'UTC')
      AND (
        ("tierId" = 'verify' AND "productsIncluded" < 4)
        OR ("tierId" = 'plus' AND "productsIncluded" < 8)
        OR ("tierId" = 'founding' AND "productsIncluded" < 15)
      )
    GROUP BY "tierId", "productsIncluded"
    ORDER BY "tierId", "productsIncluded"
  LOOP
    RAISE NOTICE 'TIER-COUNTS: % running % tier(s) held % products and are raised', r.n, r."tierId", r."productsIncluded";
  END LOOP;
END $$;

UPDATE "PlanSetting" SET "value" = to_jsonb(4), "updatedByAdminId" = NULL, "updatedAt" = (now() AT TIME ZONE 'UTC')
  WHERE "key" = 'plan.tier.verify.products' AND "value" IS DISTINCT FROM to_jsonb(4);
UPDATE "PlanSetting" SET "value" = to_jsonb(8), "updatedByAdminId" = NULL, "updatedAt" = (now() AT TIME ZONE 'UTC')
  WHERE "key" = 'plan.tier.plus.products' AND "value" IS DISTINCT FROM to_jsonb(8);
UPDATE "PlanSetting" SET "value" = to_jsonb(15), "updatedByAdminId" = NULL, "updatedAt" = (now() AT TIME ZONE 'UTC')
  WHERE "key" = 'plan.tier.founding.products' AND "value" IS DISTINCT FROM to_jsonb(15);

UPDATE "MakerTier" SET "productsIncluded" = 4, "updatedAt" = (now() AT TIME ZONE 'UTC')
  WHERE "tierId" = 'verify' AND "activeUntil" > (now() AT TIME ZONE 'UTC') AND "productsIncluded" < 4;
UPDATE "MakerTier" SET "productsIncluded" = 8, "updatedAt" = (now() AT TIME ZONE 'UTC')
  WHERE "tierId" = 'plus' AND "activeUntil" > (now() AT TIME ZONE 'UTC') AND "productsIncluded" < 8;
UPDATE "MakerTier" SET "productsIncluded" = 15, "updatedAt" = (now() AT TIME ZONE 'UTC')
  WHERE "tierId" = 'founding' AND "activeUntil" > (now() AT TIME ZONE 'UTC') AND "productsIncluded" < 15;
