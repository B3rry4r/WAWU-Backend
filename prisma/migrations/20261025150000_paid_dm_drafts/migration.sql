-- INBOX-17: a paid question waits in its own table until its wallet payment
-- is made, so the creator's inbox never shows an unpaid question.
--
-- Additive only: one new table, no column of any existing table changes.
-- Rollback: DROP TABLE "PaidDmDraft";

-- CreateTable
CREATE TABLE "PaidDmDraft" (
    "id" TEXT NOT NULL,
    "senderWawuId" TEXT NOT NULL,
    "creatorWawuId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "responseWindowHours" INTEGER NOT NULL,
    "requestKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaidDmDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaidDmDraft_senderWawuId_requestKey_key" ON "PaidDmDraft"("senderWawuId", "requestKey");

-- CreateIndex
CREATE INDEX "PaidDmDraft_senderWawuId_creatorWawuId_idx" ON "PaidDmDraft"("senderWawuId", "creatorWawuId");

-- CreateIndex
CREATE INDEX "PaidDmDraft_createdAt_idx" ON "PaidDmDraft"("createdAt");
