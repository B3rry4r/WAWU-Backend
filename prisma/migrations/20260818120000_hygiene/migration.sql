-- Hygiene pass: payment-lookup uniques, missing hot-path indexes, and a
-- self-referential FK that made deleting a parent comment impossible.
--
-- ORDERING MATTERS. Everything that CAN fail on existing data runs first,
-- behind an explicit duplicate check, so this migration aborts with an
-- actionable message instead of a raw Postgres constraint error. Prisma runs
-- each migration file in a single transaction, so an abort leaves the
-- database exactly as it was — nothing is half-applied.
--
-- ADDING A UNIQUE CONSTRAINT FAILS IF DUPLICATES ALREADY EXIST. The three
-- guards below detect that condition up front. If one fires, resolve the
-- duplicates first (they are, by definition, either a replayed payment
-- verify or test data), e.g.:
--
--   SELECT "flutterwaveTxRef", count(*), array_agg("id")
--   FROM "Purchase" GROUP BY 1 HAVING count(*) > 1;
--
-- ...then decide per row which record is real before re-running. Do NOT add
-- a blind de-dupe DELETE here: these are money rows.

-- ---------------------------------------------------------------------------
-- 1. Preflight: refuse to proceed if a payment reference is duplicated.
-- ---------------------------------------------------------------------------

DO $$
DECLARE dupes integer;
BEGIN
  SELECT count(*) INTO dupes FROM (
    SELECT 1 FROM "Purchase" GROUP BY "flutterwaveTxRef" HAVING count(*) > 1
  ) d;
  IF dupes > 0 THEN
    RAISE EXCEPTION
      'Purchase.flutterwaveTxRef has % duplicated value(s); resolve them before applying the unique index (see the comment at the top of this migration).', dupes;
  END IF;
END $$;

DO $$
DECLARE dupes integer;
BEGIN
  SELECT count(*) INTO dupes FROM (
    SELECT 1 FROM "CreditPurchase" GROUP BY "flutterwaveTxRef" HAVING count(*) > 1
  ) d;
  IF dupes > 0 THEN
    RAISE EXCEPTION
      'CreditPurchase.flutterwaveTxRef has % duplicated value(s); resolve them before applying the unique index.', dupes;
  END IF;
END $$;

DO $$
DECLARE dupes integer;
BEGIN
  SELECT count(*) INTO dupes FROM (
    SELECT 1 FROM "DirectMessage" GROUP BY "flutterwaveTxRef" HAVING count(*) > 1
  ) d;
  IF dupes > 0 THEN
    RAISE EXCEPTION
      'DirectMessage.flutterwaveTxRef has % duplicated value(s); resolve them before applying the unique index.', dupes;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Unique indexes on the payment lookup keys.
--    Every Flutterwave verify/webhook finds its row by tx_ref; without these
--    that was a sequential scan, and nothing stopped a replayed callback from
--    inserting a second row for one charge.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX "Purchase_flutterwaveTxRef_key" ON "Purchase"("flutterwaveTxRef");
CREATE UNIQUE INDEX "CreditPurchase_flutterwaveTxRef_key" ON "CreditPurchase"("flutterwaveTxRef");
CREATE UNIQUE INDEX "DirectMessage_flutterwaveTxRef_key" ON "DirectMessage"("flutterwaveTxRef");

-- ---------------------------------------------------------------------------
-- 3. Missing read-path indexes. Always safe — no data conditions.
-- ---------------------------------------------------------------------------

-- Earnings/reporting group and filter by purchase type.
CREATE INDEX "Purchase_type_idx" ON "Purchase"("type");

-- Feed/explore is "approved content, newest first"; the single-column status
-- index still left Postgres sorting the whole approved set.
CREATE INDEX "ContentPiece_status_createdAt_idx" ON "ContentPiece"("status", "createdAt");

-- Notification sweeps/retention run over createdAt across all users.
CREATE INDEX "Notification_createdAt_idx" ON "Notification"("createdAt");

-- ---------------------------------------------------------------------------
-- 4. Comment.replyTo: NO ACTION -> SET NULL.
--    Deleting a comment that had replies raised a foreign-key violation, which
--    surfaced as a 500. `replyToId` is nullable, so an orphaned reply becomes a
--    top-level comment instead of being destroyed with its parent.
--    (ON UPDATE CASCADE matches Prisma's default for an optional relation with
--    onDelete: SetNull — keeps the schema and the database in step.)
-- ---------------------------------------------------------------------------

ALTER TABLE "Comment" DROP CONSTRAINT "Comment_replyToId_fkey";
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_replyToId_fkey"
  FOREIGN KEY ("replyToId") REFERENCES "Comment"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
