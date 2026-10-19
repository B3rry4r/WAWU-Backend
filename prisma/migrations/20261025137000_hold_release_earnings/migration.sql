-- A held payment's release as an earning (WALLET-17 round 2, R-55, lead ruling
-- 17 Oct 2026): a paid question's 85% and an event host's share of the
-- tickets no longer travel as a transfer of their own. The release is one
-- database write that settles the hold and makes the payee's
-- "EarningSettlement" for the payment, and the share then goes to the payee's
-- wallet in their ONE move a day with the rest of their earnings.
--
-- Until now the database refused an earning for any payment that has a hold
-- ("a held kind's 85% lands by the hold's release"), so the same share could
-- not be owed twice. That is still true; the one thing that changes is which
-- holds count as "the share is already owed to the payee": a hold that was
-- RELEASED AS AN EARNING (status released, action release, no transfer of its
-- own: "transferKobo" and "customerReference" are NULL), for the same payee and
-- exactly the same share, may have its earning. A hold that is held, refunded,
-- or released by a transfer of its own still refuses one.
--
-- Additive in effect: no table, column or row changes. One trigger function
-- is replaced (CREATE OR REPLACE) with a looser rule for one case; every rule
-- it had for a sale and for a host's share of credits is the same text. The
-- other direction ("WalletHold_no_earning_guard": no hold for a payment that
-- already has an earning) is untouched.
--
-- Rollback: restore "EarningSettlement_insert_guard" from
-- 20261025136000_host_share_earnings (after the earnings made from holds have
-- landed or been withdrawn).

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
  -- A payment with a hold has an earning only when its hold was released as
  -- one: settled for this payee and this share, with no transfer of its own.
  IF EXISTS (
       SELECT 1 FROM "WalletHold" h
        WHERE h."paymentId" = NEW."paymentId"
          AND NOT (h."status" = 'released'
                   AND h."action" = 'release'
                   AND h."transferKobo" IS NULL
                   AND h."customerReference" IS NULL
                   AND h."payeeWawuUserId" IS NOT DISTINCT FROM NEW."payeeWawuUserId"
                   AND h."payeeShareKobo" = NEW."amountKobo")) THEN
    RAISE EXCEPTION 'EarningSettlement: payment % has a hold that was not released as this earning; its share lands by the hold''s release', NEW."paymentId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
