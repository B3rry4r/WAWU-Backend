\set ON_ERROR_STOP on
-- Rollback for 20261227090000_conversation_note_index (REC-DELETE round 1). Run with: psql -1 -f rollback.sql
-- It drops one index and nothing else: no row, column or note is touched, so there is nothing it can lose and nothing to
-- refuse over. The Hub build before this one reads the same notes with a slower query.
DROP INDEX IF EXISTS "AiToolJob_conversation_note_idx";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261227090000_conversation_note_index';
