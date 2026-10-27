\set ON_ERROR_STOP on
-- Rollback of 20261211090000_points_bought_never_expire (POINTS-BOUGHT, R-101 point 7). Run it only after the Hub
-- build that stores bought lots with the "never" end is gone. Run with: psql -1 -f rollback.sql
-- It puts the old end back on every lot the migration cleared (from "PointLotExpiryChange"), then drops that table.
-- It REFUSES, and changes nothing, in two cases, because putting the old end back would make the lot end in the past:
--   1. points were spent from the lot after its old end (a `hold` ledger row dated after it): under the old rules
--      those points could not have been spent, and the lot would show as spent after it ended;
--   2. the lot still holds points and its old end has already passed: the expiry job would write them off at once.
-- Bought lots granted AFTER the migration have no old end to restore; they keep the "never" end, which an older
-- build reads as an ordinary date far away.
DO $$
DECLARE
  spent_after integer;
  would_lose integer;
BEGIN
  SELECT count(*) INTO spent_after
  FROM "PointLotExpiryChange" c
  WHERE EXISTS (
    SELECT 1 FROM "PointLedger" g
    WHERE g."lotId" = c."lotId" AND g."reason" = 'hold' AND g."at" > c."previousExpiresAt"
  );
  IF spent_after > 0 THEN
    RAISE EXCEPTION 'POINTS-BOUGHT rollback: % bought lot(s) have points spent after their old end date, so their old end cannot be put back. Nothing was changed.', spent_after;
  END IF;

  SELECT count(*) INTO would_lose
  FROM "PointLotExpiryChange" c
  JOIN "PointLot" l ON l."id" = c."lotId"
  WHERE l."remaining" > 0 AND c."previousExpiresAt" <= now();
  IF would_lose > 0 THEN
    RAISE EXCEPTION 'POINTS-BOUGHT rollback: % bought lot(s) still hold points and their old end date has passed, so putting it back would write the points off. Nothing was changed.', would_lose;
  END IF;
END $$;

-- The trigger "PointLot_fixed_fields" holds a lot's end fixed; it is off for this update only (the lock ALTER TABLE
-- takes keeps other writes waiting until this transaction ends).
ALTER TABLE "PointLot" DISABLE TRIGGER "PointLot_fixed_fields";
UPDATE "PointLot" l SET "expiresAt" = c."previousExpiresAt"
FROM "PointLotExpiryChange" c
WHERE l."id" = c."lotId" AND l."expiresAt" = TIMESTAMP '2099-12-31 23:59:59.999';
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE "PointLot" ENABLE TRIGGER "PointLot_fixed_fields";
SET CONSTRAINTS ALL DEFERRED;

DROP TABLE "PointLotExpiryChange";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261211090000_points_bought_never_expire';
