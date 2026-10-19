-- WALLET-16 round 3, ruling R-55 (owner, 16 Oct 2026): one move a day per creator.
--
-- Additive only: one new table ("EarningMove"), one new nullable column
-- ("EarningSettlement"."moveId"), indexes, CHECKs and two trigger functions.
-- Nothing existing changes meaning, and nothing is backfilled: an earning
-- with no move is simply one the next daily move has not taken yet.
--
-- EarningMove: the ONE transfer of a creator's earnings on a day. It takes
-- every earning of the creator that is owed and in no move when the day's
-- move is made (their total at least the floor, a setting); the earnings it
-- holds point at it by "moveId". "dayKey" is the Africa/Lagos date the move
-- was made on; (payee, dayKey) is unique, so two servers on one day make one
-- move. "customerReference" names the creator and the day (and the try, after
-- a proven failure): the provider sees one reference per move.
--
-- What the database refuses, so the rules hold whatever the code does:
--   * a status other than owed or landed; a landed move without its time,
--     its destination or its send, or an owed one with a time;
--   * an amount that is not above 0, no earnings, or a try below 1;
--   * a second OPEN move (owed, not in review) for one creator and provider:
--     a creator has one transfer in flight at a time, so one a day;
--   * a move whose payee, day, provider or account changes, a landed move
--     that changes at all, and a first-refusal time or a review mark that is
--     moved or cleared once set (R-55: the 72 hours count from the FIRST
--     refusal and later refusals do not restart them; the review is once);
--   * an earning joining or leaving a move that belongs to another person or
--     provider, that has been sent, or that has landed.
--
-- Rollback: ALTER TABLE "EarningSettlement" DROP COLUMN "moveId"; DROP TABLE
-- "EarningMove"; DROP FUNCTION "EarningMove_guard"(); DROP FUNCTION
-- "EarningSettlement_move_guard"(); DROP INDEX "EarningSettlement_unmoved_idx".

-- CreateTable
CREATE TABLE "EarningMove" (
    "id" TEXT NOT NULL,
    "payeeWawuUserId" TEXT NOT NULL,
    "dayKey" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'fintava',
    "merchantAccountNumber" TEXT NOT NULL,
    "amountKobo" BIGINT NOT NULL,
    "earnings" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'owed',
    "settledAt" TIMESTAMP(3),
    "customerReference" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "destinationAccountNumber" TEXT,
    "sentAt" TIMESTAMP(3),
    "providerFeeKobo" BIGINT,
    "nextAttemptAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "checks" INTEGER NOT NULL DEFAULT 0,
    "waiting" TEXT,
    "firstRefusedAt" TIMESTAMP(3),
    "reviewSince" TIMESTAMP(3),
    "discrepancy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EarningMove_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "EarningSettlement" ADD COLUMN "moveId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "EarningMove_customerReference_key" ON "EarningMove"("customerReference");

-- CreateIndex
CREATE UNIQUE INDEX "EarningMove_payeeWawuUserId_dayKey_key" ON "EarningMove"("payeeWawuUserId", "dayKey");

-- CreateIndex
CREATE INDEX "EarningMove_status_reviewSince_nextAttemptAt_idx" ON "EarningMove"("status", "reviewSince", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "EarningSettlement_moveId_idx" ON "EarningSettlement"("moveId");

-- AddForeignKey
ALTER TABLE "EarningSettlement" ADD CONSTRAINT "EarningSettlement_moveId_fkey" FOREIGN KEY ("moveId") REFERENCES "EarningMove"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CheckConstraints
ALTER TABLE "EarningMove" ADD CONSTRAINT "EarningMove_status_check"
    CHECK ("status" IN ('owed', 'landed'));
ALTER TABLE "EarningMove" ADD CONSTRAINT "EarningMove_amount_check"
    CHECK ("amountKobo" > 0 AND "earnings" >= 1 AND "attempt" >= 1);
ALTER TABLE "EarningMove" ADD CONSTRAINT "EarningMove_settled_check"
    CHECK (("status" = 'owed') = ("settledAt" IS NULL));
ALTER TABLE "EarningMove" ADD CONSTRAINT "EarningMove_landed_check"
    CHECK (
      ("status" = 'owed')
      OR ("status" = 'landed'
          AND "destinationAccountNumber" IS NOT NULL
          AND "sentAt" IS NOT NULL)
    );

-- One open move per creator and provider: one transfer in flight at a time.
CREATE UNIQUE INDEX "EarningMove_one_open_per_payee"
    ON "EarningMove"("payeeWawuUserId", "provider")
    WHERE "status" = 'owed' AND "reviewSince" IS NULL;

-- The planner's question: which creators have earnings no move has taken yet.
CREATE INDEX "EarningSettlement_unmoved_idx"
    ON "EarningSettlement"("payeeWawuUserId")
    WHERE "status" = 'owed' AND "moveId" IS NULL AND "reviewSince" IS NULL;

-- What never changes once a move is made, and what changes once.
CREATE FUNCTION "EarningMove_guard"() RETURNS trigger AS $$
BEGIN
  IF NEW."payeeWawuUserId" IS DISTINCT FROM OLD."payeeWawuUserId"
     OR NEW."dayKey" IS DISTINCT FROM OLD."dayKey"
     OR NEW."provider" IS DISTINCT FROM OLD."provider"
     OR NEW."merchantAccountNumber" IS DISTINCT FROM OLD."merchantAccountNumber" THEN
    RAISE EXCEPTION 'EarningMove %: whose move it is, for which day and from which account never changes', OLD."id";
  END IF;
  IF OLD."status" = 'landed' AND (
       NEW."status" IS DISTINCT FROM OLD."status"
    OR NEW."settledAt" IS DISTINCT FROM OLD."settledAt"
    OR NEW."amountKobo" IS DISTINCT FROM OLD."amountKobo"
    OR NEW."earnings" IS DISTINCT FROM OLD."earnings"
    OR NEW."customerReference" IS DISTINCT FROM OLD."customerReference"
    OR NEW."destinationAccountNumber" IS DISTINCT FROM OLD."destinationAccountNumber"
    OR NEW."attempt" IS DISTINCT FROM OLD."attempt"
    OR NEW."providerFeeKobo" IS DISTINCT FROM OLD."providerFeeKobo"
  ) THEN
    RAISE EXCEPTION 'EarningMove %: a landed move never changes', OLD."id";
  END IF;
  -- Once the move has been handed to the provider, what it moves and under
  -- which reference changes only through a proven failure (a new try).
  IF OLD."sentAt" IS NOT NULL AND NEW."sentAt" IS NOT NULL
     AND NEW."attempt" = OLD."attempt" AND (
       NEW."amountKobo" IS DISTINCT FROM OLD."amountKobo"
    OR NEW."customerReference" IS DISTINCT FROM OLD."customerReference"
  ) THEN
    RAISE EXCEPTION 'EarningMove %: a move that was sent keeps its amount and its reference', OLD."id";
  END IF;
  -- R-55: the 72 hours count from the FIRST refusal; the review is once.
  IF OLD."firstRefusedAt" IS NOT NULL
     AND NEW."firstRefusedAt" IS DISTINCT FROM OLD."firstRefusedAt" THEN
    RAISE EXCEPTION 'EarningMove %: the first refusal is not moved', OLD."id";
  END IF;
  IF OLD."reviewSince" IS NOT NULL
     AND NEW."reviewSince" IS DISTINCT FROM OLD."reviewSince" THEN
    RAISE EXCEPTION 'EarningMove %: the review mark is set once', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "EarningMove_guard_trigger"
    BEFORE UPDATE ON "EarningMove"
    FOR EACH ROW EXECUTE FUNCTION "EarningMove_guard"();

-- An earning joins or leaves a move only while both are owed and the move has
-- not been handed to the provider, and only a move of the same person and
-- provider.
CREATE FUNCTION "EarningSettlement_move_guard"() RETURNS trigger AS $$
DECLARE
  m RECORD;
BEGIN
  IF NEW."moveId" IS NOT DISTINCT FROM OLD."moveId" THEN
    RETURN NEW;
  END IF;
  IF OLD."status" <> 'owed' THEN
    RAISE EXCEPTION 'EarningSettlement %: a landed earning stays in its move', OLD."id";
  END IF;
  IF NEW."moveId" IS NOT NULL THEN
    SELECT "payeeWawuUserId", "provider", "status", "sentAt" INTO m
      FROM "EarningMove" WHERE "id" = NEW."moveId";
    IF NOT FOUND
       OR m."payeeWawuUserId" <> NEW."payeeWawuUserId"
       OR m."provider" <> NEW."provider"
       OR m."status" <> 'owed' OR m."sentAt" IS NOT NULL THEN
      RAISE EXCEPTION 'EarningSettlement %: it joins only a move of the same person and provider that has not been sent', OLD."id";
    END IF;
  END IF;
  IF OLD."moveId" IS NOT NULL THEN
    SELECT "status", "sentAt" INTO m FROM "EarningMove" WHERE "id" = OLD."moveId";
    IF FOUND AND (m."status" <> 'owed' OR m."sentAt" IS NOT NULL) THEN
      RAISE EXCEPTION 'EarningSettlement %: it leaves a move only before the move is sent', OLD."id";
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "EarningSettlement_move_guard_trigger"
    BEFORE UPDATE OF "moveId" ON "EarningSettlement"
    FOR EACH ROW EXECUTE FUNCTION "EarningSettlement_move_guard"();
