\set ON_ERROR_STOP on
-- Rollback of 20261101100000_ai_tool_job_outputs (AITOOLS-02). Drops the three
-- columns and nothing else: every "AiToolJob" row stays, with the columns the
-- table had before (a done VoiceOver or Quick voice job still finds its audio
-- by "audioKey"). Run with: psql -1 -f rollback.sql
-- Refuses (and changes nothing) while any row keeps something only these
-- columns hold: an output that is not the job's own audio (words or subtitles
-- a person paid points for), an "outputs" value that is not a list at all, a
-- provider's job id, or a person's uploaded input. Copy them out first only if
-- you mean to lose them.
-- If "providerRef" is the only thing that refuses: it is the note of a copy the
-- AI provider may still hold of a person's words or recording (AITOOLS-04). The
-- Hub clears it on its own as soon as a read of the copy says it is gone, in the
-- minute after the job or at the next per-minute sweep (a cleaned recording's
-- item: up to 11 minutes). So stop the Hub (or wait two minutes and look again),
-- list what is left with
--   SELECT "id", "providerRef", "finishedAt" FROM "AiToolJob" WHERE "providerRef" IS NOT NULL;
-- and for each note either delete the copy at the provider by hand and then run
--   UPDATE "AiToolJob" SET "providerRef" = NULL WHERE "id" = '<id>';
-- or, if the copy is known to be gone, run that UPDATE straight away. Never clear
-- a note for a copy that may still be there: it is the only record that the
-- provider holds a person's words.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "AiToolJob"
     WHERE "providerRef" IS NOT NULL
        OR "inputRef" IS NOT NULL
        OR ("outputs" IS NOT NULL AND jsonb_typeof("outputs") <> 'array')
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof("outputs") = 'array' THEN "outputs" ELSE '[]'::jsonb END
          ) AS o
          WHERE o->>'kind' IS DISTINCT FROM 'audio' OR o->>'key' IS DISTINCT FROM "audioKey"
        )
  ) THEN
    RAISE EXCEPTION 'AITOOLS-02 rollback: a job keeps an output, a provider id or an uploaded input only these columns hold. Nothing was changed.';
  END IF;
END $$;
ALTER TABLE "AiToolJob"
  DROP COLUMN "outputs",
  DROP COLUMN "providerRef",
  DROP COLUMN "inputRef";
