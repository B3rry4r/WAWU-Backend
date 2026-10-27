-- STORE-QUESTION (R-101, owner, 27 Oct 2026, ruling 1A): in the app, a paid question is a store purchase at the list
-- price. The creator's 85% of the list price is earned when they answer; a question not answered by its deadline gives the
-- asker a question credit worth the list price, usable to ask any creator a question at that price or less, never cash.
--
-- Additive only. Nothing the web or the dashboard calls reads any of this:
--   * "StoreIntentKind" gains `question` (the value is not used in this file: a new enum value cannot be used in the
--     transaction that adds it);
--   * "StorePurchaseIntent" gains nullable "questionText" and "questionWindowHours": the words and the creator's reply
--     window, held only until the sale sends the question (then the words live on the direct message and are cleared);
--   * "StoreCredit" gains nullable "scope": null for every existing credit (a piece, a tip or a pass), `question` for a
--     question credit. A check keeps it to those two values.
--
-- Rollback: rollback.sql in this folder. It refuses while any question intent or any scoped credit exists, because those
-- are records of money. The `question` value stays in "StoreIntentKind": Postgres cannot drop an enum value.

ALTER TYPE "StoreIntentKind" ADD VALUE IF NOT EXISTS 'question';

-- AlterTable
ALTER TABLE "StorePurchaseIntent" ADD COLUMN "questionText" TEXT,
ADD COLUMN "questionWindowHours" INTEGER;

-- AlterTable
ALTER TABLE "StoreCredit" ADD COLUMN "scope" TEXT;

ALTER TABLE "StoreCredit" ADD CONSTRAINT "StoreCredit_scope_check"
    CHECK ("scope" IS NULL OR "scope" = 'question');
ALTER TABLE "StorePurchaseIntent" ADD CONSTRAINT "StorePurchaseIntent_question_window_check"
    CHECK ("questionWindowHours" IS NULL OR "questionWindowHours" BETWEEN 1 AND 8760);
