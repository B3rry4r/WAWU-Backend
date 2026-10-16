-- POINTS-01: points held in lots that expire, the holds that spend them, and
-- the append-only points ledger (R-43). Additive: three new tables and four
-- new enums; no existing table, column, index or row is touched.
--
-- What the database itself guarantees, whatever the code does:
--   * a lot never holds fewer than 0 points or more than it was granted, so a
--     person's points can never go below zero;
--   * a lot's who, where from, how many and when it ends never change;
--   * a lot's points always equal the sum of its ledger rows, checked when
--     each transaction commits, so no change to a lot can skip the ledger;
--   * a ledger row is never updated; it is deleted only by the account purge
--     (a transaction that sets wawu.points_purge to the person's id joined to
--     that transaction's own id), only that one person's rows, and all of
--     them in one statement;
--   * the ledger is never truncated;
--   * a hold is `held` until it is committed or released, and a settled hold
--     never changes again; who, what for, which job and how many never change;
--   * a lot ends after 2000-01-01 and before 2100-01-01 (UTC), so every
--     stored end reads back (no -infinity, no year 10000).
--
-- Rollback (nothing else references these tables):
--   DROP TABLE "PointLedger"; DROP TABLE "PointHold"; DROP TABLE "PointLot";
--   DROP FUNCTION points_ledger_refuse_update(); DROP FUNCTION points_ledger_purge_only();
--   DROP FUNCTION points_ledger_refuse_truncate(); DROP FUNCTION points_lot_fixed_fields();
--   DROP FUNCTION points_lot_matches_ledger(); DROP FUNCTION points_hold_transitions();
--   DROP TYPE "PointHoldState"; DROP TYPE "PointHoldPurpose";
--   DROP TYPE "PointLedgerReason"; DROP TYPE "PointLotSource";

-- CreateEnum
CREATE TYPE "PointLotSource" AS ENUM ('tier_bonus', 'pack', 'bump', 'referral', 'shortfall', 'returned');

-- CreateEnum
CREATE TYPE "PointLedgerReason" AS ENUM ('grant', 'hold', 'release', 'expire');

-- CreateEnum
CREATE TYPE "PointHoldPurpose" AS ENUM ('ai_job', 'cash_out');

-- CreateEnum
CREATE TYPE "PointHoldState" AS ENUM ('held', 'committed', 'released');

-- CreateTable
CREATE TABLE "PointLot" (
    "id" TEXT NOT NULL,
    "wawuUserId" TEXT NOT NULL,
    "source" "PointLotSource" NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "remaining" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lapsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PointLot_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PointLot_quantity_positive" CHECK ("quantity" > 0),
    CONSTRAINT "PointLot_remaining_in_range" CHECK ("remaining" >= 0 AND "remaining" <= "quantity"),
    CONSTRAINT "PointLot_sourceRef_length" CHECK (char_length("sourceRef") BETWEEN 1 AND 200),
    -- The upper bound is the one PointsService checks (POINTS_LATEST_END in
    -- points-config.ts); the lower one keeps out -infinity and other ends no
    -- grant can make (the service refuses any end at or before now). An end
    -- Postgres can store but JavaScript cannot read back never gets in.
    CONSTRAINT "PointLot_expiresAt_bounded" CHECK (
        "expiresAt" > TIMESTAMP '2000-01-01 00:00:00'
        AND "expiresAt" < TIMESTAMP '2100-01-01 00:00:00'
    )
);

-- CreateTable
CREATE TABLE "PointHold" (
    "id" TEXT NOT NULL,
    "wawuUserId" TEXT NOT NULL,
    "purpose" "PointHoldPurpose" NOT NULL,
    "reference" TEXT NOT NULL,
    "title" TEXT,
    "quantity" INTEGER NOT NULL,
    "state" "PointHoldState" NOT NULL DEFAULT 'held',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "PointHold_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PointHold_quantity_positive" CHECK ("quantity" > 0),
    CONSTRAINT "PointHold_reference_length" CHECK (char_length("reference") BETWEEN 1 AND 200),
    CONSTRAINT "PointHold_settled_when_final" CHECK (("state" = 'held') = ("settledAt" IS NULL))
);

-- CreateTable
CREATE TABLE "PointLedger" (
    "id" TEXT NOT NULL,
    "wawuUserId" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" "PointLedgerReason" NOT NULL,
    "holdId" TEXT,
    "reference" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "seq" BIGSERIAL NOT NULL,

    CONSTRAINT "PointLedger_pkey" PRIMARY KEY ("id"),
    -- A grant and a release add points; a hold and an expiry take them.
    CONSTRAINT "PointLedger_delta_sign" CHECK (
        ("reason" IN ('grant', 'release') AND "delta" > 0)
        OR ("reason" IN ('hold', 'expire') AND "delta" < 0)
    ),
    -- Only a hold and its release belong to a hold.
    CONSTRAINT "PointLedger_hold_rows" CHECK (("reason" IN ('hold', 'release')) = ("holdId" IS NOT NULL))
);

-- CreateIndex
CREATE INDEX "PointLot_wawuUserId_expiresAt_idx" ON "PointLot"("wawuUserId", "expiresAt");

-- CreateIndex
CREATE INDEX "PointLot_expiresAt_idx" ON "PointLot"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "PointLot_source_sourceRef_key" ON "PointLot"("source", "sourceRef");

-- CreateIndex
CREATE INDEX "PointHold_wawuUserId_createdAt_idx" ON "PointHold"("wawuUserId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PointHold_purpose_reference_key" ON "PointHold"("purpose", "reference");

-- CreateIndex
CREATE INDEX "PointLedger_wawuUserId_seq_idx" ON "PointLedger"("wawuUserId", "seq");

-- CreateIndex
CREATE INDEX "PointLedger_lotId_idx" ON "PointLedger"("lotId");

-- CreateIndex
CREATE INDEX "PointLedger_holdId_idx" ON "PointLedger"("holdId");

-- AddForeignKey
ALTER TABLE "PointLedger" ADD CONSTRAINT "PointLedger_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "PointLot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PointLedger" ADD CONSTRAINT "PointLedger_holdId_fkey" FOREIGN KEY ("holdId") REFERENCES "PointHold"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- The ledger is append-only.
-- ---------------------------------------------------------------------------

-- No ledger row is ever updated.
CREATE FUNCTION points_ledger_refuse_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'PointLedger is append-only: a ledger row is never updated'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "PointLedger_no_update"
  BEFORE UPDATE ON "PointLedger"
  FOR EACH ROW EXECUTE FUNCTION points_ledger_refuse_update();

-- A ledger row is deleted only by the account purge: a transaction that has
-- taken one person's points lock and set wawu.points_purge to
-- '<person id>:<txid_current()>' (set_config(..., true), so it ends with the
-- transaction), and deletes all of that person's rows and nobody else's in
-- one statement. The transaction id binds the setting to the transaction
-- that set it: a value left on a connection at session level (SET, or
-- set_config(..., false)) names an earlier transaction and never matches a
-- later one. Any other delete, one of some rows, one across several people,
-- or one without a matching setting, is refused. A statement that deletes
-- nothing passes.
CREATE FUNCTION points_ledger_purge_only() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  flag TEXT := current_setting('wawu.points_purge', true);
  this_tx TEXT := ':' || txid_current()::text;
  purging TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM gone) THEN
    RETURN NULL;
  END IF;
  IF flag IS NULL OR length(flag) <= length(this_tx) OR right(flag, length(this_tx)) <> this_tx THEN
    RAISE EXCEPTION 'PointLedger is append-only: ledger rows are deleted only by the account purge'
      USING ERRCODE = 'restrict_violation';
  END IF;
  purging := left(flag, length(flag) - length(this_tx));
  IF EXISTS (SELECT 1 FROM gone g WHERE g."wawuUserId" IS DISTINCT FROM purging) THEN
    RAISE EXCEPTION 'PointLedger is append-only: the purge deletes only the purged person''s rows'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM "PointLedger" l WHERE l."wawuUserId" = purging) THEN
    RAISE EXCEPTION 'PointLedger is append-only: a person''s ledger rows are deleted all together or not at all'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "PointLedger_delete_by_purge_only"
  AFTER DELETE ON "PointLedger"
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION points_ledger_purge_only();

CREATE FUNCTION points_ledger_refuse_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'PointLedger is append-only: it is never truncated'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "PointLedger_no_truncate"
  BEFORE TRUNCATE ON "PointLedger"
  FOR EACH STATEMENT EXECUTE FUNCTION points_ledger_refuse_truncate();

-- ---------------------------------------------------------------------------
-- A lot: what it is never changes, and its points always match its ledger.
-- ---------------------------------------------------------------------------

CREATE FUNCTION points_lot_fixed_fields() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."wawuUserId" IS DISTINCT FROM OLD."wawuUserId"
     OR NEW."source" IS DISTINCT FROM OLD."source"
     OR NEW."sourceRef" IS DISTINCT FROM OLD."sourceRef"
     OR NEW."quantity" IS DISTINCT FROM OLD."quantity"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'PointLot: only its remaining points and lapse time change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "PointLot_fixed_fields"
  BEFORE UPDATE ON "PointLot"
  FOR EACH ROW EXECUTE FUNCTION points_lot_fixed_fields();

-- At commit, every lot a transaction wrote (or wrote a ledger row for) holds
-- exactly the sum of its ledger rows. A change to a lot without its ledger
-- row, or a ledger row without its change, rolls the whole transaction back.
CREATE FUNCTION points_lot_matches_ledger() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  lot_id TEXT;
  lot_remaining INTEGER;
  ledger_sum BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'PointLot' THEN
    lot_id := NEW."id";
  ELSE
    lot_id := NEW."lotId";
  END IF;
  SELECT p."remaining" INTO lot_remaining FROM "PointLot" p WHERE p."id" = lot_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT COALESCE(SUM(l."delta"), 0) INTO ledger_sum FROM "PointLedger" l WHERE l."lotId" = lot_id;
  IF ledger_sum <> lot_remaining THEN
    RAISE EXCEPTION 'PointLot % holds % points but its ledger sums to %', lot_id, lot_remaining, ledger_sum
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "PointLot_matches_ledger"
  AFTER INSERT OR UPDATE ON "PointLot"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION points_lot_matches_ledger();

CREATE CONSTRAINT TRIGGER "PointLedger_matches_lot"
  AFTER INSERT ON "PointLedger"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION points_lot_matches_ledger();

-- ---------------------------------------------------------------------------
-- A hold moves once: held, then committed or released, never back.
-- ---------------------------------------------------------------------------

CREATE FUNCTION points_hold_transitions() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."wawuUserId" IS DISTINCT FROM OLD."wawuUserId"
     OR NEW."purpose" IS DISTINCT FROM OLD."purpose"
     OR NEW."reference" IS DISTINCT FROM OLD."reference"
     OR NEW."title" IS DISTINCT FROM OLD."title"
     OR NEW."quantity" IS DISTINCT FROM OLD."quantity"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'PointHold: only its state and settle time change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."state" <> 'held'
     AND (NEW."state" IS DISTINCT FROM OLD."state"
          OR NEW."settledAt" IS DISTINCT FROM OLD."settledAt") THEN
    RAISE EXCEPTION 'PointHold: a committed or released hold never changes'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "PointHold_transitions"
  BEFORE UPDATE ON "PointHold"
  FOR EACH ROW EXECUTE FUNCTION points_hold_transitions();
