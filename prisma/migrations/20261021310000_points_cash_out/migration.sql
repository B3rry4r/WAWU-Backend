-- Points converted to cash (task POINTS-04, R-43, R-31).
--
-- Additive only: one new table ("PointConversion") and four trigger functions.
-- No existing column, index or row changes meaning, and nothing is backfilled.
--
-- PointConversion: one row per request to turn points into naira in the
-- person's wallet. The row and the points hold it rests on (POINTS-01,
-- purpose 'cash_out', reference = the row's id) are written in one
-- transaction; the row is 'held' until the wallet provider CONFIRMS the cash
-- (then 'paid', and the hold is committed in the same transaction) or its own
-- record says nothing moved (then 'cancelled', and the hold is released).
-- "customerReference" is unique and names the row ('wawu-pts-' || id): one
-- conversion, one reference, so a retry, a replay, two Hub processes or a
-- crash between the provider's answer and our write can never move the cash
-- twice at the provider. Every figure is whole points or BIGINT kobo.
--
-- What the database refuses, so the rules hold whatever the code does:
--   * a status other than held, paid or cancelled; a settled row without its
--     time, or a held one with a time; a paid row that was never handed to
--     the provider; a cancelled row without its reason;
--   * points or kobo that are not above 0;
--   * an amount that is not exactly the rate applied to the points, rounded
--     down (floor(points x kobo per 1,000 points / 1,000));
--   * a reference that is not 'wawu-pts-' followed by the row's id;
--   * a row that is not born 'held', or whose account number is not WAWU's
--     own (the trigger on insert);
--   * a row whose points, amount, rate, reference, provider or WAWU account
--     changes, a person that changes to another person (only to nobody, when
--     the account is deleted), and a paid or cancelled row that changes in
--     what says how it ended (the trigger on update);
--   * at COMMIT, a conversion whose status disagrees with its points hold: a
--     held row needs a held hold, a paid row a committed one, a cancelled row
--     a released one (the hold may be gone only with the person's points, when
--     the account is deleted). So the points leave their lots exactly when the
--     cash is confirmed, and come back exactly when it is not.
--
-- Rollback (nothing else references this table):
--   DROP TABLE "PointConversion"; DROP FUNCTION "PointConversion_insert_guard"();
--   DROP FUNCTION "PointConversion_guard"(); DROP FUNCTION "PointConversion_hold_agrees"();

-- CreateTable
CREATE TABLE "PointConversion" (
    "id" TEXT NOT NULL,
    "wawuUserId" TEXT,
    "points" INTEGER NOT NULL,
    "cashKobo" BIGINT NOT NULL,
    "per1000PointsKobo" BIGINT NOT NULL,
    "merchantAccountNumber" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'fintava',
    "status" TEXT NOT NULL DEFAULT 'held',
    "settledAt" TIMESTAMP(3),
    "customerReference" TEXT NOT NULL,
    "destinationAccountNumber" TEXT,
    "sentAt" TIMESTAMP(3),
    "providerFeeKobo" BIGINT,
    "nextAttemptAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "checks" INTEGER NOT NULL DEFAULT 0,
    "reviewSince" TIMESTAMP(3),
    "discrepancy" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PointConversion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PointConversion_customerReference_key" ON "PointConversion"("customerReference");

-- CreateIndex
CREATE INDEX "PointConversion_status_reviewSince_nextAttemptAt_idx" ON "PointConversion"("status", "reviewSince", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "PointConversion_wawuUserId_createdAt_idx" ON "PointConversion"("wawuUserId", "createdAt");

-- CheckConstraints
ALTER TABLE "PointConversion" ADD CONSTRAINT "PointConversion_status_check"
    CHECK ("status" IN ('held', 'paid', 'cancelled'));
ALTER TABLE "PointConversion" ADD CONSTRAINT "PointConversion_amounts_check"
    CHECK ("points" > 0 AND "cashKobo" > 0 AND "per1000PointsKobo" > 0);
-- The cash is exactly the rate applied to the points, rounded down. Postgres
-- divides a positive BIGINT by truncating, which is a floor here.
ALTER TABLE "PointConversion" ADD CONSTRAINT "PointConversion_rate_check"
    CHECK ("cashKobo" = ("points"::bigint * "per1000PointsKobo") / 1000);
ALTER TABLE "PointConversion" ADD CONSTRAINT "PointConversion_settled_check"
    CHECK (("status" = 'held') = ("settledAt" IS NULL));
-- A NULL must make an arm false, not unknown (MONEY-18 round 2, F3): each
-- non-held arm states what it needs as NOT NULL.
ALTER TABLE "PointConversion" ADD CONSTRAINT "PointConversion_paid_check"
    CHECK (("status" <> 'paid') OR ("status" = 'paid' AND "sentAt" IS NOT NULL));
ALTER TABLE "PointConversion" ADD CONSTRAINT "PointConversion_cancelled_check"
    CHECK (("status" <> 'cancelled') OR ("status" = 'cancelled' AND "failureReason" IS NOT NULL));
ALTER TABLE "PointConversion" ADD CONSTRAINT "PointConversion_reference_check"
    CHECK ("customerReference" = 'wawu-pts-' || "id");

-- A row is born held, with nothing settled and nothing sent.
CREATE FUNCTION "PointConversion_insert_guard"() RETURNS trigger AS $$
BEGIN
  IF NEW."status" <> 'held' OR NEW."settledAt" IS NOT NULL OR NEW."sentAt" IS NOT NULL THEN
    RAISE EXCEPTION 'PointConversion %: a conversion is made held, with nothing sent', NEW."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PointConversion_insert_guard_trigger"
    BEFORE INSERT ON "PointConversion"
    FOR EACH ROW EXECUTE FUNCTION "PointConversion_insert_guard"();

-- What never changes once the row is made: the points, the amount, the rate,
-- the reference, the provider and WAWU's account. The person never becomes
-- another person (only nobody: the account purge anonymises the row). A paid
-- or cancelled row changes in nothing that says how it ended; the schedule
-- and the notes stay writable.
CREATE FUNCTION "PointConversion_guard"() RETURNS trigger AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."points" IS DISTINCT FROM OLD."points"
     OR NEW."cashKobo" IS DISTINCT FROM OLD."cashKobo"
     OR NEW."per1000PointsKobo" IS DISTINCT FROM OLD."per1000PointsKobo"
     OR NEW."merchantAccountNumber" IS DISTINCT FROM OLD."merchantAccountNumber"
     OR NEW."provider" IS DISTINCT FROM OLD."provider"
     OR NEW."customerReference" IS DISTINCT FROM OLD."customerReference"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'PointConversion %: what is converted, and for how much, never changes', OLD."id";
  END IF;
  IF NEW."wawuUserId" IS DISTINCT FROM OLD."wawuUserId" AND NEW."wawuUserId" IS NOT NULL THEN
    RAISE EXCEPTION 'PointConversion %: a conversion never passes to another person', OLD."id";
  END IF;
  IF OLD."status" <> 'held' AND (
       NEW."status" IS DISTINCT FROM OLD."status"
    OR NEW."settledAt" IS DISTINCT FROM OLD."settledAt"
    OR NEW."providerFeeKobo" IS DISTINCT FROM OLD."providerFeeKobo"
    OR NEW."failureReason" IS DISTINCT FROM OLD."failureReason"
  ) THEN
    RAISE EXCEPTION 'PointConversion %: a settled conversion never changes', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PointConversion_guard_trigger"
    BEFORE UPDATE ON "PointConversion"
    FOR EACH ROW EXECUTE FUNCTION "PointConversion_guard"();

-- The conversion and its points hold agree, checked when the transaction
-- commits (the service writes them in one transaction, the conversion first
-- and the hold last). The hold is the one POINTS-01 keeps for purpose
-- 'cash_out' under this row's id.
CREATE FUNCTION "PointConversion_hold_agrees"() RETURNS trigger AS $$
DECLARE
  h TEXT;
BEGIN
  SELECT "state"::text INTO h FROM "PointHold"
   WHERE "purpose" = 'cash_out' AND "reference" = NEW."id";
  IF NOT FOUND THEN
    -- Gone only with the person's points, when the account is deleted (the
    -- purge removes the hold first and anonymises this row after it).
    IF TG_OP = 'UPDATE' THEN
      RETURN NULL;
    END IF;
    RAISE EXCEPTION 'PointConversion %: there is no points hold for it', NEW."id";
  END IF;
  IF (NEW."status" = 'held' AND h <> 'held')
     OR (NEW."status" = 'paid' AND h <> 'committed')
     OR (NEW."status" = 'cancelled' AND h <> 'released') THEN
    RAISE EXCEPTION 'PointConversion %: the conversion is % but its points are %', NEW."id", NEW."status", h;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "PointConversion_matches_hold"
    AFTER INSERT OR UPDATE OF "status" ON "PointConversion"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION "PointConversion_hold_agrees"();
