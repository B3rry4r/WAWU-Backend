-- TIER-05: pay a tier purchase by bank transfer at checkout.
--
-- Additive only: one new table. No existing table, column or index changes.
--
-- PlanTransferOrder: a purchase the person confirmed with their PIN and will
-- pay by sending money to their own wallet account. It waits as `awaiting`,
-- is paid from the wallet exactly once when the money lands (`settling`, then
-- `settled` with the wallet payment's id), or closes (`expired`, `closed`).
-- "openKey" is unique while a row is `awaiting` (one waiting order per person
-- and item) and null otherwise; "paymentId" is unique, so one wallet payment
-- belongs to at most one order. The CHECKs only keep the figures sane.
--
-- Rollback: DROP TABLE "PlanTransferOrder". Nothing else refers to it.

-- CreateTable
CREATE TABLE "PlanTransferOrder" (
    "id" TEXT NOT NULL,
    "wawuUserId" TEXT NOT NULL,
    "paymentKind" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "priceKobo" INTEGER NOT NULL,
    "providerFeeKobo" INTEGER NOT NULL,
    "totalKobo" INTEGER NOT NULL,
    "terms" JSONB,
    "status" TEXT NOT NULL DEFAULT 'awaiting',
    "statusMessage" TEXT,
    "openKey" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "paymentId" TEXT,
    "settlingSince" TIMESTAMP(3),
    "creditsSeenAt" TIMESTAMP(3),
    "nextCheckAt" TIMESTAMP(3),
    "checks" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanTransferOrder_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PlanTransferOrder_figures_sane" CHECK ("priceKobo" >= 1 AND "providerFeeKobo" >= 0 AND "totalKobo" >= "priceKobo"),
    CONSTRAINT "PlanTransferOrder_status_known" CHECK ("status" IN ('awaiting', 'settling', 'settled', 'expired', 'closed'))
);

-- CreateIndex
CREATE UNIQUE INDEX "PlanTransferOrder_openKey_key" ON "PlanTransferOrder"("openKey");

-- CreateIndex
CREATE UNIQUE INDEX "PlanTransferOrder_paymentId_key" ON "PlanTransferOrder"("paymentId");

-- CreateIndex
CREATE INDEX "PlanTransferOrder_status_createdAt_idx" ON "PlanTransferOrder"("status", "createdAt");

-- CreateIndex
CREATE INDEX "PlanTransferOrder_wawuUserId_status_createdAt_idx" ON "PlanTransferOrder"("wawuUserId", "status", "createdAt");
