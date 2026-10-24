\set ON_ERROR_STOP on
-- Rollback of 20261102090100_community_notice_retry (FIX-105 round 2). Run it only after the Hub build that reads this
-- table is gone. Run with: psql -1 -f rollback.sql
-- Refuses (and changes nothing) while any row is stored. Each row is a room whose notices are still owed: the sweep's
-- cursor has already moved past it, so dropping the table would lose that to-do list for good and those people would
-- never get their notice. Let the sweep finish first (the table empties as each room is tried again and succeeds), or
-- clear it on purpose once you accept that those notices are never written:
--   DELETE FROM "CommunityNoticeRetry";
-- The notices already written are untouched either way.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "CommunityNoticeRetry") THEN
    RAISE EXCEPTION 'FIX-105 rollback: rooms whose notices are still owed are stored in "CommunityNoticeRetry" and would be forgotten. Nothing was changed.';
  END IF;
END $$;
DROP TABLE "CommunityNoticeRetry";
