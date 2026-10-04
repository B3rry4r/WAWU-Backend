-- Receipts (task WALLET-18): one short public code per ledger row its owner
-- chose to share (wawu/r/<code>, W41 to W43).
--
-- Additive only: one new table. No existing table, column, index or row is
-- touched. (`prisma migrate diff` against a database built from every
-- earlier migration also proposes dropping "ContentPiece_specializations_idx",
-- the GIN index that 20260921090000_content_specializations adds in raw SQL
-- and the schema cannot express; that line is not part of this migration.)
--
-- Rollback: DROP TABLE "MoneyReceipt";

-- CreateTable
CREATE TABLE "MoneyReceipt" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "wawuUserId" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MoneyReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MoneyReceipt_code_key" ON "MoneyReceipt"("code");

-- CreateIndex
CREATE UNIQUE INDEX "MoneyReceipt_entryId_key" ON "MoneyReceipt"("entryId");

-- CreateIndex
CREATE INDEX "MoneyReceipt_wawuUserId_idx" ON "MoneyReceipt"("wawuUserId");
