-- Rollback for 20261024060000_account_deletion_piece_index (SETTINGS-06 round 9).
-- Run with: psql -1 -f rollback.sql
-- Drops the index; the lookup by piece then scans the table, which is slower
-- and still right.
DROP INDEX IF EXISTS "AccountDeletionContent_contentPieceId_idx";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261024060000_account_deletion_piece_index';
