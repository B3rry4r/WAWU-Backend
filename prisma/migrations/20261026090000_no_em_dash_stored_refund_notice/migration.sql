-- SWEEP-APP-1 (FIX-09 L1, owner rule R-5): no em-dash in anything a person can read.
--
-- Until commit 259e6c5 the paid-DM refund notice was stored as
-- 'Your N has been refunded <dash> the creator did not reply within 24 hours.'
-- FIX-09's migration (20261022130000) rewrote only ServiceApplication, so the
-- Notification rows written before it still carry the dash and the inbox shows
-- them. They are rewritten here to the wording the code now writes.
--
-- One new table, nothing existing changed: no column, index or constraint on
-- "Notification" is touched, so an older instance keeps working and the web and
-- the dashboard read the same shapes. Before the UPDATE, the id and the body of
-- every row it will change are copied into "NotificationRefundNoticeBackup", so
-- rollback.sql (next to this file) can put the old words back. The backup holds
-- an id and a body that says only an amount ('Your N500 has been refunded ...'),
-- no person's id. Dropping the table is its own task, after two weeks with no
-- rollback.
-- Idempotent: a second run matches no row, copies none and changes none. The
-- dash is written as chr(8212) so this file does not depend on how it is read.

-- CreateTable
CREATE TABLE "NotificationRefundNoticeBackup" (
    "notificationId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "savedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationRefundNoticeBackup_pkey" PRIMARY KEY ("notificationId")
);

-- The rows the UPDATE below will change, as they are now. A row already saved
-- keeps its first copy.
INSERT INTO "NotificationRefundNoticeBackup" ("notificationId", "body")
SELECT "id", "body"
FROM "Notification"
WHERE position(
  ' has been refunded ' || chr(8212) || ' the creator did not reply within 24 hours.' IN "body"
) > 0
ON CONFLICT ("notificationId") DO NOTHING;

UPDATE "Notification"
SET "body" = replace(
  "body",
  ' has been refunded ' || chr(8212) || ' the creator did not reply within 24 hours.',
  ' has been refunded. The creator did not reply within 24 hours.'
)
WHERE position(
  ' has been refunded ' || chr(8212) || ' the creator did not reply within 24 hours.' IN "body"
) > 0;
