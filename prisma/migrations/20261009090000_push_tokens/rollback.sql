-- Rollback for 20261009090000_push_tokens. Run by hand, never by
-- `prisma migrate deploy` (it only reads migration.sql). Drops the two new
-- tables and nothing else. Afterwards, delete the row for this migration from
-- "_prisma_migrations" so a redeploy can reapply.
DROP TABLE "PushDelivery";
DROP TABLE "PushToken";
