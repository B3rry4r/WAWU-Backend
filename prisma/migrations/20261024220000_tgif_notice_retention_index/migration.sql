-- HOME-17: lets the daily TGIF notice clean-up find the old `tgif_daily`
-- notices without reading every other notification.
-- Additive: one new partial index on "Notification", no table, column or row
-- touched, and no existing index changed (protected route registry, H-1).
-- Prisma's schema cannot write a partial index; this is the database object.
-- Rollback: DROP INDEX "Notification_tgif_daily_createdAt_idx";
-- (then DELETE FROM "_prisma_migrations" WHERE migration_name = '20261024220000_tgif_notice_retention_index').

CREATE INDEX IF NOT EXISTS "Notification_tgif_daily_createdAt_idx" ON "Notification"("createdAt") WHERE "kind" = 'tgif_daily';
