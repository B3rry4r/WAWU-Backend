-- WALLET-17: a community host's share of the credits spent in their room is an
-- earning like any other, and travels in the creator's one move a day (R-55).
--
-- An earning (EarningSettlement) was always one finished sale (a WalletPayment).
-- It may now also be one CreditSpendEarning, the host's share of one spent
-- credit: "paymentId" becomes nullable, "creditSpendEarningId" is added (unique),
-- and exactly one of the two is set. Nothing about a payment's earning changes:
-- every existing row keeps its "paymentId", every guard still applies to it.
--
-- Additive: one new nullable column and a nullable relaxation on a table that
-- only the wmt branches write (the earnings sweep, WALLET-16). The web and the
-- dashboard never read it.
--
-- Rollback: DELETE FROM "EarningSettlement" WHERE "paymentId" IS NULL (after the
-- moves holding them have landed or been withdrawn); ALTER TABLE
-- "EarningSettlement" DROP COLUMN "creditSpendEarningId"; ALTER COLUMN
-- "paymentId" SET NOT NULL; restore the two functions below from
-- 20261025120000_earning_settlements.

-- AlterTable
ALTER TABLE "EarningSettlement" ALTER COLUMN "paymentId" DROP NOT NULL;
ALTER TABLE "EarningSettlement" ADD COLUMN "creditSpendEarningId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "EarningSettlement_creditSpendEarningId_key" ON "EarningSettlement"("creditSpendEarningId");

-- AddForeignKey
ALTER TABLE "EarningSettlement" ADD CONSTRAINT "EarningSettlement_creditSpendEarningId_fkey" FOREIGN KEY ("creditSpendEarningId") REFERENCES "CreditSpendEarning"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Exactly one source, and the reference names it.
ALTER TABLE "EarningSettlement" ADD CONSTRAINT "EarningSettlement_source_check"
    CHECK (("paymentId" IS NULL) <> ("creditSpendEarningId" IS NULL));
ALTER TABLE "EarningSettlement" DROP CONSTRAINT "EarningSettlement_reference_check";
ALTER TABLE "EarningSettlement" ADD CONSTRAINT "EarningSettlement_reference_check"
    CHECK (
      ("paymentId" IS NOT NULL
         AND starts_with("customerReference", 'wawu-earn-' || "paymentId"))
      OR ("creditSpendEarningId" IS NOT NULL
         AND starts_with("customerReference", 'wawu-earn-cs-' || "creditSpendEarningId"))
    );

-- A row for a sale is made as before. A row for a host's share is made only
-- for a share of this host, for exactly that share, and once (the unique
-- index): the same spent credit cannot be paid twice.
CREATE OR REPLACE FUNCTION "EarningSettlement_insert_guard"() RETURNS trigger AS $$
DECLARE
  p RECORD;
  c RECORD;
BEGIN
  IF NEW."paymentId" IS NULL THEN
    SELECT "creatorWawuId", "hostShareKobo" INTO c
      FROM "CreditSpendEarning" WHERE "id" = NEW."creditSpendEarningId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'EarningSettlement: credit earning % does not exist', NEW."creditSpendEarningId";
    END IF;
    IF c."creatorWawuId" IS DISTINCT FROM NEW."payeeWawuUserId"
       OR c."hostShareKobo"::bigint <> NEW."amountKobo" THEN
      RAISE EXCEPTION 'EarningSettlement: credit earning % is owed to another person or share', NEW."creditSpendEarningId";
    END IF;
    RETURN NEW;
  END IF;
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

-- What never changes once the row is made, now including the credit earning.
CREATE OR REPLACE FUNCTION "EarningSettlement_guard"() RETURNS trigger AS $$
BEGIN
  IF NEW."paymentId" IS DISTINCT FROM OLD."paymentId"
     OR NEW."creditSpendEarningId" IS DISTINCT FROM OLD."creditSpendEarningId"
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
