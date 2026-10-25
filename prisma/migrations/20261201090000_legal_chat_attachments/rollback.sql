\set ON_ERROR_STOP on
-- Rollback of 20261201090000_legal_chat_attachments (R2-LEGAL3). Run it only after the Hub build that reads these columns is gone.
-- Run with: psql -1 -f rollback.sql
-- Refuses (and changes nothing) while any chat line carries a file: dropping the columns would lose the only record of which
-- document the person sent on which matter (the files stay in storage, but nothing would say whose they are or what they were).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "LegalChatMessage" WHERE "attachmentKey" IS NOT NULL) THEN
    RAISE EXCEPTION 'R2-LEGAL3 rollback: chat lines carry files people sent and would lose them. Nothing was changed.';
  END IF;
END $$;
DROP INDEX "LegalChatMessage_attachmentKey_key";
ALTER TABLE "LegalChatMessage" DROP COLUMN "attachmentName";
ALTER TABLE "LegalChatMessage" DROP COLUMN "attachmentBytes";
ALTER TABLE "LegalChatMessage" DROP COLUMN "attachmentContentType";
ALTER TABLE "LegalChatMessage" DROP COLUMN "attachmentKey";
