\set ON_ERROR_STOP on
-- Rollback of 20261125090000_world_wallet (WALLET-41). Drops the audit table
-- and the seven columns the migration added to "FintavaWalletOpening", and nothing
-- else. Run with: psql -1 -f rollback.sql
-- Refuses (and changes nothing) while the audit table holds a row (it is the
-- record of an admin's act) or any person's opening carries a world country
-- (dropping the column would forget which people opened without a BVN, and
-- their first account's currency). Copy them out first only if you mean to
-- lose them.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "WorldAdminAudit")
     OR EXISTS (
       SELECT 1 FROM "FintavaWalletOpening"
       WHERE "worldCountry" IS NOT NULL
          OR "worldFirstCurrency" IS NOT NULL
          OR "worldAccountRequestedAt" IS NOT NULL
          OR "worldAccountOpenedAt" IS NOT NULL
          OR "worldFrozenAt" IS NOT NULL
          OR "worldFrozenReason" IS NOT NULL
          OR "worldCancelledAt" IS NOT NULL
     )
  THEN
    RAISE EXCEPTION 'WALLET-41 rollback: world wallet openings or audit rows exist. Nothing was changed.';
  END IF;
END $$;
DROP TABLE "WorldAdminAudit";
DROP INDEX "FintavaWalletOpening_worldCountry_idx";
ALTER TABLE "FintavaWalletOpening"
  DROP COLUMN "worldCancelledAt",
  DROP COLUMN "worldFrozenReason",
  DROP COLUMN "worldFrozenAt",
  DROP COLUMN "worldAccountOpenedAt",
  DROP COLUMN "worldAccountRequestedAt",
  DROP COLUMN "worldFirstCurrency",
  DROP COLUMN "worldCountry";
