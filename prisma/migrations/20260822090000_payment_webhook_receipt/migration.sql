-- Inbound Flutterwave webhook deliveries: audit trail + the exactly-once
-- claim for provider-driven settlement. New table rather than new columns on
-- the existing money tables, because most wire types are bare Prisma
-- re-exports returned by spread and a new column would widen a live response.
CREATE TABLE "PaymentWebhookReceipt" (
    "id" TEXT NOT NULL,
    "deliveryKey" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "txRef" TEXT NOT NULL,
    "transactionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'received',
    "flow" TEXT,
    "detail" TEXT,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),
    CONSTRAINT "PaymentWebhookReceipt_pkey" PRIMARY KEY ("id")
);

-- The claim. One settlement attempt per event per tx_ref; a duplicate
-- delivery loses this insert and never reaches settlement.
CREATE UNIQUE INDEX "PaymentWebhookReceipt_deliveryKey_key" ON "PaymentWebhookReceipt"("deliveryKey");

CREATE INDEX "PaymentWebhookReceipt_txRef_idx" ON "PaymentWebhookReceipt"("txRef");
CREATE INDEX "PaymentWebhookReceipt_status_idx" ON "PaymentWebhookReceipt"("status");
CREATE INDEX "PaymentWebhookReceipt_receivedAt_idx" ON "PaymentWebhookReceipt"("receivedAt");
