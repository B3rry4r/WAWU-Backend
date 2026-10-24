\set ON_ERROR_STOP on
-- Rollback of 20261108093000_add_money_sessions (WALLET-25, WALLET-26). Drops the two tables and nothing else.
-- Refuses (and changing nothing) while any attempt is still open or was credited: an open attempt may still settle
-- at Nuvion and a credited one is the Hub's link between a ledger row and Nuvion's inflow. Copy them out first
-- only if you mean to lose them. Run with: psql -1 -f rollback.sql
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "AddMoneySession"
     WHERE "status" IN ('created', 'awaiting_user', 'processing', 'settled')
        OR "ledgerEntryId" IS NOT NULL
        OR "frozen"
        OR "reviewNote" IS NOT NULL
  )
  THEN
    RAISE EXCEPTION 'WALLET-25 rollback: an add-money attempt is open, credited, frozen or marked for review. Nothing was changed.';
  END IF;
END $$;
DROP TABLE "AddMoneyAudit";
DROP TABLE "AddMoneySession";
