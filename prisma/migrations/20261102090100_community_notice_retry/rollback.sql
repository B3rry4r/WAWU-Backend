\set ON_ERROR_STOP on
-- Rollback of 20261102090100_community_notice_retry (FIX-105 round 2). Run it only after the Hub build that reads this
-- table is gone. Run with: psql -1 -f rollback.sql
-- The table holds only the rooms the sweep still has to try again (a room id and times, no person's data). Dropping
-- it loses nothing but that to-do list: the notices already written are untouched.
DROP TABLE "CommunityNoticeRetry";
