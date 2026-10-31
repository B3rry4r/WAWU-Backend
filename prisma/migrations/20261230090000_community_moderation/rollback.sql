\set ON_ERROR_STOP on
-- Rollback for 20261230090000_community_moderation (MOD-ROOMS, R-122). It REFUSES while either table holds a row and
-- changes nothing: a "CommunityMute" row is a mute in force (dropping the table would silently lift it and let the member
-- write again), and a "CommunityModerationLog" row is a record of what a host did, which is not lost by a rollback.
-- Unmute each member first (DELETE /communities/:id/mutes/:userWawuId) and export the log, then delete its rows
-- deliberately; only then does this run. Run with: psql -1 -f rollback.sql
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "CommunityMute") THEN
    RAISE EXCEPTION 'rollback refused: a CommunityMute is still in force';
  END IF;
  IF EXISTS (SELECT 1 FROM "CommunityModerationLog") THEN
    RAISE EXCEPTION 'rollback refused: the CommunityModerationLog still holds rows';
  END IF;
END $$;

DROP TABLE "CommunityModerationLog";
DROP TABLE "CommunityMute";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261230090000_community_moderation';
