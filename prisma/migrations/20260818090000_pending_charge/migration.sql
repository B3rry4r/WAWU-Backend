-- Durable bridge between a Flutterwave charge init and its verify.
-- Replaces a process-local in-memory Map that was lost on any deploy,
-- crash or second replica, stranding real payments with no server record.
CREATE TABLE "PendingCharge" (
    "txRef" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "wawuUserId" TEXT NOT NULL,
    "expectedAmount" INTEGER NOT NULL,
    "context" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PendingCharge_pkey" PRIMARY KEY ("txRef")
);

CREATE INDEX "PendingCharge_wawuUserId_idx" ON "PendingCharge"("wawuUserId");
CREATE INDEX "PendingCharge_createdAt_idx" ON "PendingCharge"("createdAt");
