\set ON_ERROR_STOP on
-- Rollback of 20261105100000_ai_tools_voiceover_extras (AITOOLS-07). Drops the
-- four columns and nothing else: every row of the three tables stays, with the
-- columns it had before. Run with: psql -1 -f rollback.sql
-- Refuses (and changes nothing) while any column holds a value only it keeps: a
-- result a person saved, a person's agreement to VoiceOver in their own voice
-- (dropping it would lose the record of what they agreed to and when), or a
-- draft that uses a job's audio. Copy them out first only if you mean to lose
-- them.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "AiToolJob" WHERE "savedAt" IS NOT NULL)
     OR EXISTS (
       SELECT 1 FROM "VoiceProfile"
        WHERE "ownVoiceConsentAt" IS NOT NULL OR "ownVoiceConsentLine" IS NOT NULL
     )
     OR EXISTS (SELECT 1 FROM "ProductDraft" WHERE "mediaJobId" IS NOT NULL)
  THEN
    RAISE EXCEPTION 'AITOOLS-07 rollback: a saved result, an own-voice agreement or a draft that uses a job''s audio exists. Nothing was changed.';
  END IF;
END $$;
ALTER TABLE "ProductDraft" DROP COLUMN "mediaJobId";
ALTER TABLE "VoiceProfile"
  DROP COLUMN "ownVoiceConsentAt",
  DROP COLUMN "ownVoiceConsentLine";
ALTER TABLE "AiToolJob" DROP COLUMN "savedAt";
