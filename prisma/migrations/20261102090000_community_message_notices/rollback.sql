\set ON_ERROR_STOP on
-- Rollback of 20261102090000_community_message_notices (FIX-105). Run it only after the Hub build that reads these
-- tables is gone. Run with: psql -1 -f rollback.sql
-- Refuses (and changes nothing) while any grouped community notice is stored: those notifications are rows in
-- "Notification" that the older build does not know how to draw, and dropping the count table leaves them as bare
-- rows. Delete them first on purpose:
--   DELETE FROM "Notification" WHERE "kind" = 'community_messages';
-- (that removes their counts too). The cursor holds only the sweep's position and is rebuilt on the next start.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "CommunityMessageNotice") THEN
    RAISE EXCEPTION 'FIX-105 rollback: grouped community notices are stored and would lose their counts. Nothing was changed.';
  END IF;
END $$;
DROP TABLE "CommunityNoticeCursor";
DROP TABLE "CommunityMessageNotice";
DROP INDEX "CommunityMessage_sentAt_idx";
