\set ON_ERROR_STOP on
-- Rollback for 20261026090000_no_em_dash_stored_refund_notice (SWEEP-APP-1, FIX-64).
-- Run with: psql -1 -f rollback.sql
-- Puts back the exact body of every Notification the migration rewrote, from
-- "NotificationRefundNoticeBackup", then drops that table and forgets the
-- migration so it can run again. A notification deleted since is skipped (its
-- backup row goes with the table). A body edited since by anything other than
-- the migration is put back only when it still reads as the migration left it.
UPDATE "Notification" AS n
SET "body" = b."body"
FROM "NotificationRefundNoticeBackup" AS b
WHERE n."id" = b."notificationId"
  AND n."body" = replace(
    b."body",
    ' has been refunded ' || chr(8212) || ' the creator did not reply within 24 hours.',
    ' has been refunded. The creator did not reply within 24 hours.'
  );
DROP TABLE "NotificationRefundNoticeBackup";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261026090000_no_em_dash_stored_refund_notice';
