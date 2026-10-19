-- A sale's 85% landing in the payee's wallet (task WALLET-16, R-11).
--
-- Additive only: one new table ("EarningSettlement"), one partial index on
-- "WalletPayment" and three trigger functions. No existing column, index or
-- row changes meaning, and nothing is backfilled here: the first sweep after
-- this ships makes a row for every finished ordinary sale that has none (a
-- sale of a kind nothing registered yet could not be paid before the owning
-- tasks, so on a fresh install there is none).
--
-- EarningSettlement: one row per finished ordinary sale (completed,
-- delivered, not in review, a payee, a share above 0, no hold), owed until
-- the wallet provider CONFIRMS the move of the payee's 85% from WAWU's own
-- account into the payee's wallet. `customerReference` is unique and names
-- the payment (`wawu-earn-<payment id>`): one earning, one reference, so a
-- retry, a replay, two Hub processes or a crash between the provider's
-- answer and our write can never move it twice at the provider. Every figure
-- is BIGINT kobo.
--
-- What the database refuses, so the rules hold whatever the code does:
--   * a status other than owed or landed; a landed row without its time, its
--     destination or its send, or an owed one with a time;
--   * an amount that is not above 0, or a try number below 1;
--   * a reference that does not name its payment;
--   * a row for a payment that has a hold (a held kind's 85% lands by the
--     hold's release), a payment that is not completed, another payee or
--     another share than the payment's (the trigger on insert), and the
--     other way round: a hold for a payment that has a row;
--   * a row whose payment, payee, kind, target, amount or account changes,
--     or a landed row that changes at all (the trigger on update).
--
-- Partial index on "WalletPayment": the sweep's question "which finished
-- ordinary sales have no earning yet" reads only the rows it can still need.
--
-- Rollback: DROP TABLE "EarningSettlement"; DROP FUNCTION
-- "EarningSettlement_guard"(); DROP FUNCTION "EarningSettlement_insert_guard"();
-- DROP FUNCTION "WalletHold_no_earning_guard"(); DROP INDEX
-- "WalletPayment_earning_due_idx";

-- CreateTable
CREATE TABLE "EarningSettlement" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "payeeWawuUserId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "earnedAt" TIMESTAMP(3) NOT NULL,
    "amountKobo" BIGINT NOT NULL,
    "merchantAccountNumber" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'fintava',
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
    "reviewSince" TIMESTAMP(3),
    "discrepancy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EarningSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EarningSettlement_paymentId_key" ON "EarningSettlement"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "EarningSettlement_customerReference_key" ON "EarningSettlement"("customerReference");

-- CreateIndex
CREATE INDEX "EarningSettlement_status_reviewSince_nextAttemptAt_idx" ON "EarningSettlement"("status", "reviewSince", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "EarningSettlement_payeeWawuUserId_earnedAt_idx" ON "EarningSettlement"("payeeWawuUserId", "earnedAt");

-- AddForeignKey
ALTER TABLE "EarningSettlement" ADD CONSTRAINT "EarningSettlement_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "WalletPayment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CheckConstraints
ALTER TABLE "EarningSettlement" ADD CONSTRAINT "EarningSettlement_status_check"
    CHECK ("status" IN ('owed', 'landed'));
ALTER TABLE "EarningSettlement" ADD CONSTRAINT "EarningSettlement_amount_check"
    CHECK ("amountKobo" > 0 AND "attempt" >= 1);
ALTER TABLE "EarningSettlement" ADD CONSTRAINT "EarningSettlement_settled_check"
    CHECK (("status" = 'owed') = ("settledAt" IS NULL));
-- A NULL must make an arm false, not unknown (MONEY-18 round 2, F3): each
-- non-owed arm states what it needs as NOT NULL.
ALTER TABLE "EarningSettlement" ADD CONSTRAINT "EarningSettlement_landed_check"
    CHECK (
      ("status" = 'owed')
      OR ("status" = 'landed'
          AND "destinationAccountNumber" IS NOT NULL
          AND "sentAt" IS NOT NULL)
    );
ALTER TABLE "EarningSettlement" ADD CONSTRAINT "EarningSettlement_reference_check"
    CHECK (starts_with("customerReference", 'wawu-earn-' || "paymentId"));

-- A row is made only for a completed payment of this payee, for exactly the
-- payee's share, and never for a payment that has a hold: a held kind's 85%
-- lands by the hold's release (MONEY-18), so the same share cannot land twice.
CREATE FUNCTION "EarningSettlement_insert_guard"() RETURNS trigger AS $$
DECLARE
  p RECORD;
BEGIN
  SELECT "status", "payeeWawuUserId", "payeeShareKobo", "merchantAccountNumber", "provider"
    INTO p FROM "WalletPayment" WHERE "id" = NEW."paymentId";
  IF NOT FOUND OR p."status" <> 'completed' THEN
    RAISE EXCEPTION 'EarningSettlement: payment % is not a completed payment', NEW."paymentId";
  END IF;
  IF p."payeeWawuUserId" IS DISTINCT FROM NEW."payeeWawuUserId"
     OR p."payeeShareKobo" <> NEW."amountKobo"
     OR p."merchantAccountNumber" <> NEW."merchantAccountNumber"
     OR p."provider" <> NEW."provider" THEN
    RAISE EXCEPTION 'EarningSettlement: payment % is owed to another person, share, account or provider', NEW."paymentId";
  END IF;
  IF EXISTS (SELECT 1 FROM "WalletHold" WHERE "paymentId" = NEW."paymentId") THEN
    RAISE EXCEPTION 'EarningSettlement: payment % has a hold; its share lands by the hold''s release', NEW."paymentId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "EarningSettlement_insert_guard_trigger"
    BEFORE INSERT ON "EarningSettlement"
    FOR EACH ROW EXECUTE FUNCTION "EarningSettlement_insert_guard"();

-- The other way round: a hold is never made for a payment whose share is
-- already owed by a settlement row. (A held kind is never adopted, so this
-- fires only if something else is wrong; it stops the same 85% twice.)
CREATE FUNCTION "WalletHold_no_earning_guard"() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "EarningSettlement" WHERE "paymentId" = NEW."paymentId") THEN
    RAISE EXCEPTION 'WalletHold: payment % already has an earning settlement', NEW."paymentId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "WalletHold_no_earning_guard_trigger"
    BEFORE INSERT ON "WalletHold"
    FOR EACH ROW EXECUTE FUNCTION "WalletHold_no_earning_guard"();

-- What never changes once the row is made: the payment, the payee, what was
-- sold, the amount and WAWU's account. A landed row changes in nothing that
-- says it landed (its status, time, amount, reference, destination); the
-- schedule, the review mark and the notes stay writable.
CREATE FUNCTION "EarningSettlement_guard"() RETURNS trigger AS $$
BEGIN
  IF NEW."paymentId" IS DISTINCT FROM OLD."paymentId"
     OR NEW."payeeWawuUserId" IS DISTINCT FROM OLD."payeeWawuUserId"
     OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."targetId" IS DISTINCT FROM OLD."targetId"
     OR NEW."amountKobo" IS DISTINCT FROM OLD."amountKobo"
     OR NEW."merchantAccountNumber" IS DISTINCT FROM OLD."merchantAccountNumber"
     OR NEW."earnedAt" IS DISTINCT FROM OLD."earnedAt" THEN
    RAISE EXCEPTION 'EarningSettlement %: what is owed, and to whom, never changes', OLD."id";
  END IF;
  IF OLD."status" = 'landed' AND (
       NEW."status" IS DISTINCT FROM OLD."status"
    OR NEW."settledAt" IS DISTINCT FROM OLD."settledAt"
    OR NEW."customerReference" IS DISTINCT FROM OLD."customerReference"
    OR NEW."destinationAccountNumber" IS DISTINCT FROM OLD."destinationAccountNumber"
    OR NEW."attempt" IS DISTINCT FROM OLD."attempt"
    OR NEW."providerFeeKobo" IS DISTINCT FROM OLD."providerFeeKobo"
  ) THEN
    RAISE EXCEPTION 'EarningSettlement %: a landed earning never changes', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "EarningSettlement_guard_trigger"
    BEFORE UPDATE ON "EarningSettlement"
    FOR EACH ROW EXECUTE FUNCTION "EarningSettlement_guard"();

-- The sweep's question: which finished ordinary sales have no earning yet.
CREATE INDEX "WalletPayment_earning_due_idx"
    ON "WalletPayment"("completedAt", "id")
    WHERE "status" = 'completed'
      AND "payeeWawuUserId" IS NOT NULL
      AND "payeeSettledAt" IS NULL
      AND "openKey" IS NULL;
