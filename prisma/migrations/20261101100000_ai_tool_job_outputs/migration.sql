-- AITOOLS-02: three nullable columns on "AiToolJob" that every tool of the job
-- pipeline uses. Additive only: existing rows keep every value they have and
-- read back with the three new columns NULL.
--   "outputs"     what a done job made, a JSON list of
--                 { kind: audio | text | subtitles, key?, text? }
--   "providerRef" the provider's own id for a long job (dubbing), never shown
--   "inputRef"    the key of the file the person uploaded for the job
-- Rollback: rollback.sql beside this file (it refuses while a row holds an
-- output, a provider id or an input that only these columns keep).

ALTER TABLE "AiToolJob"
  ADD COLUMN "outputs" JSONB,
  ADD COLUMN "providerRef" TEXT,
  ADD COLUMN "inputRef" TEXT;
