-- Rollback for 20261020130000_money_pin_request_keys. Run by hand, never by
-- `prisma migrate deploy` (it only reads migration.sql). Drops the one new
-- table and nothing else. Afterwards, delete the row for this migration from
-- "_prisma_migrations" so a redeploy can reapply.
DROP TABLE "MoneyPinRequestKey";
