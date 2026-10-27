\set ON_ERROR_STOP on
-- Rollback for 20261218090000_store_question (STORE-QUESTION). It refuses while a question intent or a scoped credit
-- exists: a question credit is money the Hub owes a fan, and a question intent is the record of a purchase. Neither is
-- dropped silently.
--
-- The `question` value stays in "StoreIntentKind": Postgres cannot drop an enum value. Nothing uses it once no intent
-- names it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "StorePurchaseIntent" WHERE "kind"::text = 'question' OR "questionText" IS NOT NULL OR "questionWindowHours" IS NOT NULL) THEN
    RAISE EXCEPTION 'rollback refused: a question intent exists';
  END IF;
  IF EXISTS (SELECT 1 FROM "StorePurchase" WHERE "buyKind"::text = 'question') THEN
    RAISE EXCEPTION 'rollback refused: a question purchase exists';
  END IF;
  IF EXISTS (SELECT 1 FROM "StoreCredit" WHERE "scope" IS NOT NULL) THEN
    RAISE EXCEPTION 'rollback refused: a question credit exists';
  END IF;
END $$;

ALTER TABLE "StorePurchaseIntent" DROP CONSTRAINT "StorePurchaseIntent_question_window_check";
ALTER TABLE "StoreCredit" DROP CONSTRAINT "StoreCredit_scope_check";
ALTER TABLE "StoreCredit" DROP COLUMN "scope";
ALTER TABLE "StorePurchaseIntent" DROP COLUMN "questionText", DROP COLUMN "questionWindowHours";
