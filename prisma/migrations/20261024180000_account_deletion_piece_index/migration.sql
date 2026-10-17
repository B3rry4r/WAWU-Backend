-- SETTINGS-06 round 9: a reader finds the deletion's mark of a piece by the
-- piece alone (the purge re-keys the piece and a cancel restores it while a
-- request may be half way through, so the mark is looked up without the
-- creator's id).
--
-- Additive: one index, nothing else. No row is touched.
--
-- Rollback (also in rollback.sql): drops the index.

CREATE INDEX "AccountDeletionContent_contentPieceId_idx" ON "AccountDeletionContent"("contentPieceId");
