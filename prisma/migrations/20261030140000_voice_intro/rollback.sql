-- Rollback of 20261030140000_voice_intro (VOICE-01). Nothing else references
-- these tables. Run it only after the Hub build that reads them is gone.
-- A run that is still "working" holds points (PointHold, purpose ai_job): the
-- stale-hold sweep gives them back; and a run that used the tier's included
-- first Voice Intro is put back first so no one loses it.
UPDATE "MakerTier" SET "voiceIntroIncluded" = true
 WHERE "wawuUserId" IN (
   SELECT "wawuUserId" FROM "VoiceIntroRun" WHERE "state" = 'working' AND "includedUsed"
 );
DROP TABLE "VoiceNamePreview";
DROP TABLE "VoiceIntroRun";
DROP TABLE "VoiceProfile";
