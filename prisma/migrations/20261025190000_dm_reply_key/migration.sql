-- INBOX-18 round 2 (verifier F1): a creator's reply bubble on a paid question is stored once per creator and Idempotency-Key.
--
-- Additive only: one new table. No existing table, column, index, constraint or row is changed, and a bubble sent
-- without the header never has a row here, so nothing the web or the dashboard calls behaves differently.
--
-- One row per (creator, key), pointing at the bubble that key stored. The primary key is the unique index that is the
-- lock: two requests with the same key, even on two servers at the same moment, cannot both insert it, so the second
-- one is refused by the database and answers with the first bubble instead of storing another.
-- The row goes with its bubble (ON DELETE CASCADE), and with its question when the question is deleted.
--
-- Rollback (nothing else references the table; also in rollback.sql):
--   DROP TABLE "DmReplyKey";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261025190000_dm_reply_key';

-- CreateTable
CREATE TABLE "DmReplyKey" (
    "creatorWawuId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "replyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DmReplyKey_pkey" PRIMARY KEY ("creatorWawuId","key")
);

-- CreateIndex
CREATE UNIQUE INDEX "DmReplyKey_replyId_key" ON "DmReplyKey"("replyId");

-- AddForeignKey
ALTER TABLE "DmReplyKey" ADD CONSTRAINT "DmReplyKey_replyId_fkey" FOREIGN KEY ("replyId") REFERENCES "DmReply"("id") ON DELETE CASCADE ON UPDATE CASCADE;
