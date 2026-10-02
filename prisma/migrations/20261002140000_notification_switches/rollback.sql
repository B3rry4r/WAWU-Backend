-- Rollback for 20261002140000_notification_switches. Run by hand, never by
-- `prisma migrate deploy` (it only reads migration.sql). Drops the two
-- columns; every other column and row is untouched. Afterwards, delete the
-- row for this migration from "_prisma_migrations" so a redeploy can reapply.
ALTER TABLE "NotificationSettings"
    DROP COLUMN "contentReviews",
    DROP COLUMN "moneyIn";
