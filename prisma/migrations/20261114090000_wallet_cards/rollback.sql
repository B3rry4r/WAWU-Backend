\set ON_ERROR_STOP on
-- Rollback of 20261114090000_wallet_cards (WALLET-31). Drops the WalletCard
-- table and nothing else. Run with: psql -1 -f rollback.sql
-- Refuses (and changes nothing) while the table holds any card that is not
-- `failed`: a card in `creating`, `unknown`, `active`, `frozen` or `cancelled`
-- state is the only WAWU record of a card that exists at Nuvion (its id, whose
-- it is, whether it was frozen or blocked), so dropping it would orphan a card
-- a person may still be able to spend with. Block or delete those cards first,
-- or copy the table out. The enum values added to AdminOpsResource and
-- AdminOpsAction are left in place (Postgres cannot drop an enum value).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "WalletCard" WHERE "state" <> 'failed') THEN
    RAISE EXCEPTION 'WALLET-31 rollback: WalletCard holds a card that is not failed. Nothing was changed.';
  END IF;
END $$;
DROP TABLE "WalletCard";
