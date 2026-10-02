-- Fintava webhook events (task MONEY-07).
--
-- Additive only: one new enum and one new table, nothing else. Every signed
-- Fintava delivery is recorded here once and acknowledged; nothing in this
-- table moves money or changes a balance (the ledger, MONEY-10, and the
-- pending sweep, MONEY-08, consume the `pending` rows).
--
-- Fintava sends no event id, so the unique index over (event, reference,
-- fintavaStatus) is what makes a delivery count once: the insert is
-- ON CONFLICT DO NOTHING, so a retry or two copies arriving together leave
-- one row.
--
-- "rawBody" is BYTEA: the exact bytes Fintava signed, NUL included. The
-- parsed "payload" and the text columns hold NUL as U+FFFD, since Postgres
-- text and json refuse a NUL.
--
-- `prisma migrate diff` also proposes dropping "ContentPiece_specializations_idx".
-- That index predates this task (schema drift, not ours) and is left alone.

-- CreateEnum
CREATE TYPE "FintavaWebhookProcessing" AS ENUM ('pending', 'processed', 'failed', 'unrecognised');

-- CreateTable
CREATE TABLE "FintavaWebhookEvent" (
    "id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "eventRaw" TEXT,
    "reference" TEXT NOT NULL,
    "referenceField" TEXT NOT NULL,
    "fintavaStatus" TEXT NOT NULL,
    "dataReference" TEXT,
    "dataCustomerReference" TEXT,
    "rawBody" BYTEA NOT NULL,
    "payload" JSONB NOT NULL,
    "processingStatus" "FintavaWebhookProcessing" NOT NULL DEFAULT 'pending',
    "note" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "FintavaWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FintavaWebhookEvent_processingStatus_receivedAt_idx" ON "FintavaWebhookEvent"("processingStatus", "receivedAt");

-- CreateIndex
CREATE INDEX "FintavaWebhookEvent_dataReference_idx" ON "FintavaWebhookEvent"("dataReference");

-- CreateIndex
CREATE INDEX "FintavaWebhookEvent_dataCustomerReference_idx" ON "FintavaWebhookEvent"("dataCustomerReference");

-- CreateIndex
CREATE UNIQUE INDEX "FintavaWebhookEvent_event_reference_fintavaStatus_key" ON "FintavaWebhookEvent"("event", "reference", "fintavaStatus");
