\set ON_ERROR_STOP on
-- Rollback of 20261030140000_voice_intro (VOICE-01). Nothing else references
-- these tables. Run it only after the Hub build that reads them is gone.
-- Run with: psql -1 -f rollback.sql
-- Refuses (and changes nothing) while any person's consent, words, recording or
-- Voice Intro is stored: "VoiceProfile" holds the consent line and the time the
-- person agreed to it, and "VoiceIntroRun" the tries that made their intros. A
-- consent record is worth archiving, and the audio cannot be made again for
-- free. Copy them out first only if you mean to lose them. Name spellings and
-- preview counts alone do not stop it.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "VoiceProfile"
     WHERE "consentAt" IS NOT NULL OR "consentLine" IS NOT NULL
        OR "introText" IS NOT NULL OR "sampleKey" IS NOT NULL
        OR "audioKey" IS NOT NULL
  ) OR EXISTS (SELECT 1 FROM "VoiceIntroRun") THEN
    RAISE EXCEPTION 'VOICE-01 rollback: consent, recording or Voice Intro rows are stored and would be lost. Nothing was changed.';
  END IF;
END $$;
-- Any run row stops it above, so the drop loses no included first Voice Intro
-- and no held points.
DROP TABLE "VoiceNamePreview";
DROP TABLE "VoiceIntroRun";
DROP TABLE "VoiceProfile";
