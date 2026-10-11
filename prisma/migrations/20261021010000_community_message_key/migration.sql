-- INBOX-05 round 5 (verifier defect 21): a community message is stored and charged once per sender and Idempotency-Key.
--
-- Additive only: one new table. No existing table, column, index, constraint or row is changed, and a message sent
-- without the header never has a row here, so nothing the web or the dashboard calls behaves differently.
--
-- One row per (sender, key), pointing at the message that key stored. The primary key is the unique index that is the
-- lock: two requests with the same key, even on two servers at the same moment, cannot both insert it, so the second
-- one is refused by the database and answers with the first message instead of storing and charging again.
-- The row goes with its message (ON DELETE CASCADE), and with its room when the room is deleted.
--
-- Rollback (nothing else references the table; also in rollback.sql):
--   DROP TABLE "CommunityMessageKey";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261020120000_community_message_key';

-- CreateTable
CREATE TABLE "CommunityMessageKey" (
    "senderWawuId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommunityMessageKey_pkey" PRIMARY KEY ("senderWawuId","key")
);

-- CreateIndex
CREATE UNIQUE INDEX "CommunityMessageKey_messageId_key" ON "CommunityMessageKey"("messageId");

-- AddForeignKey
ALTER TABLE "CommunityMessageKey" ADD CONSTRAINT "CommunityMessageKey_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "CommunityMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
