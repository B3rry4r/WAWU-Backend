-- Free chat between two users (task INBOX-06, DECISIONS R-13).
--
-- Additive only: three new tables and nothing else. No existing table,
-- column, index or row is touched, so the web and the dashboard are
-- unaffected. Rollback: DROP TABLE "ChatMessage", "ChatParticipant",
-- "ChatConversation" (in that order).

-- CreateTable
CREATE TABLE "ChatConversation" (
    "id" TEXT NOT NULL,
    "userAWawuId" TEXT NOT NULL,
    "userBWawuId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatParticipant" (
    "conversationId" TEXT NOT NULL,
    "wawuUserId" TEXT NOT NULL,
    "lastReadAt" TIMESTAMP(3),
    "lastReadMessageId" TEXT,

    CONSTRAINT "ChatParticipant_pkey" PRIMARY KEY ("conversationId","wawuUserId")
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "senderWawuId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "text" TEXT,
    "attachmentKey" TEXT,
    "attachmentContentType" TEXT,
    "attachmentBytes" INTEGER,
    "attachmentName" TEXT,
    "clientMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChatConversation_userAWawuId_userBWawuId_key" ON "ChatConversation"("userAWawuId", "userBWawuId");

-- CreateIndex
CREATE INDEX "ChatParticipant_wawuUserId_idx" ON "ChatParticipant"("wawuUserId");

-- CreateIndex
CREATE INDEX "ChatMessage_conversationId_createdAt_id_idx" ON "ChatMessage"("conversationId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ChatMessage_conversationId_senderWawuId_clientMessageId_key" ON "ChatMessage"("conversationId", "senderWawuId", "clientMessageId");

-- AddForeignKey
ALTER TABLE "ChatParticipant" ADD CONSTRAINT "ChatParticipant_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ChatConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ChatConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A message is text, an attachment, or both; never neither. The service
-- refuses it first with a 400; this keeps any other writer honest too.
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_text_or_attachment" CHECK ("text" IS NOT NULL OR "attachmentKey" IS NOT NULL);
