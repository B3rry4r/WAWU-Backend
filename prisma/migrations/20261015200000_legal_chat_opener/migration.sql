-- FIX-11: the legal thread's opener is written once, metered and locked.
-- Additive: one new table and its indexes, one of them a partial unique
-- index. No existing table, column, index or row is touched, so every thread
-- and every limit count written before this reads exactly as it did.
-- Rollback: DROP TABLE "LegalChatOpenerCall";

-- CreateTable
CREATE TABLE "LegalChatOpenerCall" (
    "id" TEXT NOT NULL,
    "legalRequestId" TEXT NOT NULL,
    "wawuUserId" TEXT NOT NULL,
    "busyUntil" TIMESTAMP(3),
    "outcome" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LegalChatOpenerCall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LegalChatOpenerCall_legalRequestId_createdAt_idx" ON "LegalChatOpenerCall"("legalRequestId", "createdAt");

-- CreateIndex
CREATE INDEX "LegalChatOpenerCall_wawuUserId_createdAt_idx" ON "LegalChatOpenerCall"("wawuUserId", "createdAt");

-- One opener on record per thread. Written by hand: Prisma cannot express a
-- partial index, so the schema only notes it (model LegalChatOpenerCall).
-- The opener and its `written` outcome are stored in one transaction, so a
-- second opener for the same thread is refused here even if it got past the
-- lock in the service.
CREATE UNIQUE INDEX "LegalChatOpenerCall_one_written_key" ON "LegalChatOpenerCall"("legalRequestId") WHERE "outcome" = 'written';
