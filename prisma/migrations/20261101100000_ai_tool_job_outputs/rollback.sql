\set ON_ERROR_STOP on
-- Rollback of 20261101100000_ai_tool_job_outputs (AITOOLS-02). Drops the three
-- columns and nothing else: every "AiToolJob" row stays, with the columns the
-- table had before (a done VoiceOver or Quick voice job still finds its audio
-- by "audioKey"). Run with: psql -1 -f rollback.sql
-- Refuses (and changes nothing) while any row keeps something only these
-- columns hold: an output that is not the job's own audio (words or subtitles
-- a person paid points for), a provider's job id, or a person's uploaded
-- input. Copy them out first only if you mean to lose them.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "AiToolJob"
     WHERE "providerRef" IS NOT NULL
        OR "inputRef" IS NOT NULL
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof("outputs") = 'array' THEN "outputs" ELSE '[]'::jsonb END
          ) AS o
          WHERE o->>'kind' <> 'audio' OR o->>'key' IS DISTINCT FROM "audioKey"
        )
  ) THEN
    RAISE EXCEPTION 'AITOOLS-02 rollback: a job keeps an output, a provider id or an uploaded input only these columns hold. Nothing was changed.';
  END IF;
END $$;
ALTER TABLE "AiToolJob"
  DROP COLUMN "outputs",
  DROP COLUMN "providerRef",
  DROP COLUMN "inputRef";
