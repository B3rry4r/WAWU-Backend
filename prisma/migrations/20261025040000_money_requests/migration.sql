-- INBOX-15: money requests in chat (R-13).
--
-- One new table, and one existing CHECK on ChatMessage loosened (below). No
-- column or index changes; nothing a caller sends or reads today is refused
-- or changed by this.
--
-- MoneyRequest: one ask for money written into a chat. It is also a chat
-- message ("messageId", kind `money_request`; ChatMessage.kind is free text,
-- so no column changes). `status` is pending, paid, declined or cancelled;
-- the last three are final. "transferId" is the wallet send that is paying
-- the request: unique, so one send belongs to at most one request, and set in
-- the same transaction that claims the send. The CHECKs only keep the figures
-- and words sane.
--
-- Rollback: DROP TABLE "MoneyRequest"; then drop the ChatMessage CHECK and add
-- it back as "text" IS NOT NULL OR "attachmentKey" IS NOT NULL (only once no
-- money_request message is left).

-- CreateTable
CREATE TABLE "MoneyRequest" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "requesterWawuId" TEXT NOT NULL,
    "payerWawuId" TEXT NOT NULL,
    "amountKobo" BIGINT NOT NULL,
    "memo" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "messageId" TEXT,
    "clientRequestId" TEXT,
    "transferId" TEXT,
    "changedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MoneyRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MoneyRequest_messageId_key" ON "MoneyRequest"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "MoneyRequest_transferId_key" ON "MoneyRequest"("transferId");

-- CreateIndex
CREATE INDEX "MoneyRequest_requesterWawuId_createdAt_idx" ON "MoneyRequest"("requesterWawuId", "createdAt");

-- CreateIndex
CREATE INDEX "MoneyRequest_payerWawuId_createdAt_idx" ON "MoneyRequest"("payerWawuId", "createdAt");

-- CreateIndex
CREATE INDEX "MoneyRequest_status_transferId_idx" ON "MoneyRequest"("status", "transferId");

-- CreateIndex
CREATE INDEX "MoneyRequest_changedAt_idx" ON "MoneyRequest"("changedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MoneyRequest_conversationId_requesterWawuId_clientRequestId_key" ON "MoneyRequest"("conversationId", "requesterWawuId", "clientRequestId");

-- AddForeignKey
ALTER TABLE "MoneyRequest" ADD CONSTRAINT "MoneyRequest_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ChatConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CheckStatus
ALTER TABLE "MoneyRequest" ADD CONSTRAINT "MoneyRequest_status_check" CHECK ("status" IN ('pending', 'paid', 'declined', 'cancelled'));

-- CheckAmount
ALTER TABLE "MoneyRequest" ADD CONSTRAINT "MoneyRequest_amount_check" CHECK ("amountKobo" > 0);

-- CheckTwoPeople
ALTER TABLE "MoneyRequest" ADD CONSTRAINT "MoneyRequest_two_people_check" CHECK ("requesterWawuId" <> "payerWawuId");

-- A money request is a chat message whose words are its optional reason, so
-- it may have neither text nor an attachment. The rule "text, an attachment,
-- or both" stays for every other kind. Every existing row still satisfies the
-- new rule (it only allows more).
ALTER TABLE "ChatMessage" DROP CONSTRAINT "ChatMessage_text_or_attachment";
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_text_or_attachment" CHECK ("text" IS NOT NULL OR "attachmentKey" IS NOT NULL OR "kind" = 'money_request');
