-- POINTS-BOUGHT (R-101 point 7, owner, 27 Oct 2026): "Bought points cannot be cashed out ... it can't expire ...
-- This applies for the Play Store build too". Points a person bought (a points pack, the checkout bump, a
-- shortfall top-up: lot sources 'pack', 'bump' and 'shortfall') never end. New bought lots are stored by the
-- Hub with the "never" end, 2099-12-31 23:59:59.999 UTC (src/points/points-bought.ts, POINTS_NEVER_EXPIRES), which sits
-- inside the table's own CHECK (an end after 2000 and before 2100) and sorts after every real end.
--
-- This file clears the end of the bought lots that already exist, and keeps the old dates:
--   * "PointLotExpiryChange": one row per lot whose end was cleared, with the end it had. New table, nothing else
--     reads it; the rollback reads it to put the old ends back.
--   * Lots with a lapse time (written off by the expiry job, or taken back by a store refund) are left as they
--     are: their points are already gone and are not given back. A lot that ended but was not yet written off
--     (no lapse time) is cleared, so its points stay.
--   * Earned and bonus lots (tier_bonus, referral, returned) are not touched.
-- Safe to run again: a lot already at the "never" end is not selected, and a lot already audited keeps its first row.

CREATE TABLE IF NOT EXISTS "PointLotExpiryChange" (
    "lotId" TEXT NOT NULL,
    "previousExpiresAt" TIMESTAMP(3) NOT NULL,
    "clearedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PointLotExpiryChange_pkey" PRIMARY KEY ("lotId")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PointLotExpiryChange_lotId_fkey'
  ) THEN
    ALTER TABLE "PointLotExpiryChange"
      ADD CONSTRAINT "PointLotExpiryChange_lotId_fkey"
      FOREIGN KEY ("lotId") REFERENCES "PointLot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

INSERT INTO "PointLotExpiryChange" ("lotId", "previousExpiresAt")
SELECT "id", "expiresAt" FROM "PointLot"
WHERE "source" IN ('pack', 'bump', 'shortfall')
  AND "lapsedAt" IS NULL
  AND "expiresAt" < TIMESTAMP '2099-12-31 23:59:59.999'
ON CONFLICT ("lotId") DO NOTHING;

-- A lot's end is one of the fields the trigger "PointLot_fixed_fields" holds fixed for every write the Hub makes.
-- This one-off change turns the trigger off for the update and on again straight after. ALTER TABLE takes a lock
-- that keeps every other write to the table waiting until this transaction ends, so nothing else passes while it is off.
ALTER TABLE "PointLot" DISABLE TRIGGER "PointLot_fixed_fields";
UPDATE "PointLot" SET "expiresAt" = TIMESTAMP '2099-12-31 23:59:59.999'
WHERE "id" IN (SELECT "lotId" FROM "PointLotExpiryChange")
  AND "expiresAt" < TIMESTAMP '2099-12-31 23:59:59.999';
-- The update queued the deferred check that every lot still matches its ledger; run it now (ALTER TABLE refuses
-- while checks are queued), then turn the trigger back on.
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE "PointLot" ENABLE TRIGGER "PointLot_fixed_fields";
SET CONSTRAINTS ALL DEFERRED;
