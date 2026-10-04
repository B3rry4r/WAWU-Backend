-- INBOX-08: several creator reply bubbles per paid question, and the indexes
-- the creator's waiting list and the fan's thread read through. Additive: one
-- new table, new indexes, no existing column touched.

CREATE TABLE "DmReply" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "creatorWawuId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DmReply_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DmReply_messageId_createdAt_idx" ON "DmReply"("messageId", "createdAt");

ALTER TABLE "DmReply" ADD CONSTRAINT "DmReply_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "DirectMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "DirectMessage_creatorWawuId_status_deadlineAt_idx" ON "DirectMessage"("creatorWawuId", "status", "deadlineAt");

CREATE INDEX "DirectMessage_senderWawuId_creatorWawuId_sentAt_idx" ON "DirectMessage"("senderWawuId", "creatorWawuId", "sentAt");

-- A question answered before this migration already holds its one reply in
-- DirectMessage.responseText; give it the same reply row so a thread reads
-- every answered question the same way.
INSERT INTO "DmReply" ("id", "messageId", "creatorWawuId", "text", "createdAt")
SELECT gen_random_uuid()::text, "id", "creatorWawuId", "responseText", COALESCE("respondedAt", "sentAt")
FROM "DirectMessage"
WHERE "responseText" IS NOT NULL;
