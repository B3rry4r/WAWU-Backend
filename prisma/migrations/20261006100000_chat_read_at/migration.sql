-- INBOX-02. Additive only: one nullable column. When a person's read mark in a
-- chat last moved, so the live catch-up can tell which marks changed since a
-- cursor. Existing rows keep NULL.
ALTER TABLE "ChatParticipant" ADD COLUMN "readAt" TIMESTAMP(3);
