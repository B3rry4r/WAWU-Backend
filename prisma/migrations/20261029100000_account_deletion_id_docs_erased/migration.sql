-- SETTINGS-09 (R-73). Additive. A deleted account's ID documents are kept,
-- hidden, for the days in the admin setting `id_docs_keep_days` (5 years at
-- launch) after the deletion completed (`purgedAt`), then a daily sweep deletes
-- the files and their StorageObject rows. Four columns on the deletion row,
-- which is the account's own audit line (counts only, no name, no number):
--   idDocsClaimedUntil  null or past: free. Future: a server (or an earlier
--             run that crashed, until the time passes) holds the account, so two
--             servers do not delete the same files.
--   idDocsErasedAt      null: not finished. Set: no set-aside ID document is
--             left, and the sweep never looks at the account again.
--   idDocsErased        how many files were deleted for the account (default 0).
--   idDocsKeepDays      the days kept in force when it finished.
-- Existing rows get null / 0. No row is rewritten, no index or constraint changes.
--
-- Rollback (also in rollback.sql): drops the four columns, and refuses while any
-- account has finished (idDocsErasedAt set) or has started (idDocsErased above 0)
-- so the record of what was deleted is never lost.

ALTER TABLE "AccountDeletion"
  ADD COLUMN "idDocsClaimedUntil" TIMESTAMP(3),
  ADD COLUMN "idDocsErasedAt" TIMESTAMP(3),
  ADD COLUMN "idDocsErased" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "idDocsKeepDays" INTEGER;
