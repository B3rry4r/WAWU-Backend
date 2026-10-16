-- SETTINGS-06 round 2: two more states for an account deletion, and a note.
--
-- Additive: one nullable column and a wider status check. No row is touched.
--   freezing  the person asked, the wallet is being frozen. The row exists
--             before the freeze call so a lost answer can always be undone
--             (a cancel or a retry unfreezes). Not in force yet.
--   purging   the sweep took the deletion and is deleting. A cancel is
--             refused from here on (data may already be gone).
--   purgeNote what the purge kept on purpose (content that buyers paid for,
--             hidden and anonymised). No personal detail.
--
-- Rollback (also in rollback.sql): refuses while a deletion is freezing or
-- purging, then drops the column and restores the old check.

ALTER TABLE "AccountDeletion" DROP CONSTRAINT "AccountDeletion_status_check";
ALTER TABLE "AccountDeletion" ADD CONSTRAINT "AccountDeletion_status_check"
  CHECK ("status" IN ('freezing', 'scheduled', 'purging', 'cancelled', 'purged'));
ALTER TABLE "AccountDeletion" ADD COLUMN "purgeNote" TEXT;
