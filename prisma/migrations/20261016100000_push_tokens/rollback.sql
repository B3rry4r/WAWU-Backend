-- Rollback for 20261016100000_push_tokens. Run by hand, never by
-- `prisma migrate deploy` (it only reads migration.sql). Drops the three new
-- tables and nothing else. Afterwards, delete the row for this migration from
-- "_prisma_migrations" so a redeploy can reapply.
DROP TABLE "PushStoppedAccount";
DROP TABLE "PushDelivery";
DROP TABLE "PushToken";
