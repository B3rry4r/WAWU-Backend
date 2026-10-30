\set ON_ERROR_STOP on
-- Rollback for 20261222090000_ai_cloned_voice (AITOOLS-11). It refuses while any row exists: a row is a voice the
-- provider may still hold for a person, and the consent that person gave. Remove the voices first (the person's
-- DELETE /ai-tools/my-voice, or the account purge), let the Hub delete the rows, then run this.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "AiClonedVoice") THEN
    RAISE EXCEPTION 'rollback refused: a cloned voice row exists';
  END IF;
END $$;

DROP TABLE "AiClonedVoice";
