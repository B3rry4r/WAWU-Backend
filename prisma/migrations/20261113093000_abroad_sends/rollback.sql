\set ON_ERROR_STOP on
-- Rollback of 20261113093000_abroad_sends (NUV-11). Run it only after the Hub build that reads these tables is gone.
-- Run with: psql -1 -f rollback.sql
-- Refuses (and changes nothing) while any send abroad is stored: those rows are the only record of money that left
-- an account for a foreign recipient (the provider holds its own, but the person's receipt and the admin list are
-- these rows). Export them, then delete them on purpose:
--   DELETE FROM "AbroadSend";
-- Saved recipients, held quotes, freezes and the admin audit hold no money, but the audit is a record of who did what:
-- it refuses too while it has rows.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "AbroadSend") THEN
    RAISE EXCEPTION 'NUV-11 rollback: sends abroad are stored and would be lost. Nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM "AbroadAdminAudit") THEN
    RAISE EXCEPTION 'NUV-11 rollback: the admin audit has rows and would be lost. Nothing was changed.';
  END IF;
END $$;
DROP TABLE "AbroadAdminAudit";
DROP TABLE "AbroadFreeze";
DROP TABLE "AbroadSend";
DROP TABLE "AbroadQuote";
DROP TABLE "AbroadRecipient";
