-- Every distinct Fintava delivery is stored (task MONEY-08, round 3).
--
-- MONEY-07 stored one delivery per (event, reference, fintavaStatus), so a
-- second delivery for the same transaction with the same status and other
-- figures (SUCCESS for N100, then SUCCESS for N200) was answered 200 and
-- dropped: Fintava contradicting itself never reached the ledger. A delivery
-- is now one row per body: the key is the SHA-256 of the exact bytes
-- Fintava signed ("rawBody"). A retry or a replay of the same delivery is
-- the same bytes, so it still lands on the same row (replay protection
-- kept); any other body is stored.
--
-- Additive and safe on existing rows:
-- - one nullable column, filled for every existing row from its own
--   "rawBody" in the same migration;
-- - its unique index. Existing rows cannot collide on it: two rows with the
--   same bytes would have had the same (event, reference, fintavaStatus),
--   which the old unique index refused;
-- - the old unique index becomes a plain index on the same columns (the
--   same lookups, no longer a key). No row is changed or removed.
--
-- It touches no table MONEY-12's 20261003100000_wallet_opening touches, and
-- nothing 20261003120000_ledger_status_schedule touches, so it applies in any
-- order with either.
--
-- Rollback: DROP INDEX "FintavaWebhookEvent_bodySha256_key";
--           ALTER TABLE "FintavaWebhookEvent" DROP COLUMN "bodySha256";
--           DROP INDEX "FintavaWebhookEvent_event_reference_fintavaStatus_idx";
--           and recreate the unique index, after removing any rows that
--           now share (event, reference, fintavaStatus).

-- AlterTable
ALTER TABLE "FintavaWebhookEvent" ADD COLUMN     "bodySha256" TEXT;

-- Backfill
UPDATE "FintavaWebhookEvent" SET "bodySha256" = encode(sha256("rawBody"), 'hex') WHERE "bodySha256" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "FintavaWebhookEvent_bodySha256_key" ON "FintavaWebhookEvent"("bodySha256");

-- DropIndex
DROP INDEX "FintavaWebhookEvent_event_reference_fintavaStatus_key";

-- CreateIndex
CREATE INDEX "FintavaWebhookEvent_event_reference_fintavaStatus_idx" ON "FintavaWebhookEvent"("event", "reference", "fintavaStatus");
