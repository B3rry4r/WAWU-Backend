-- WALLET-41 (R-87): a person outside Nigeria opens a wallet without a BVN.
-- Additive only: seven nullable columns on "FintavaWalletOpening", one index, and
-- one new table for the admin audit. Nothing existing is changed.

-- AlterTable
ALTER TABLE "FintavaWalletOpening" ADD COLUMN "worldCountry" TEXT,
ADD COLUMN "worldFirstCurrency" TEXT,
ADD COLUMN "worldAccountRequestedAt" TIMESTAMP(3),
ADD COLUMN "worldAccountOpenedAt" TIMESTAMP(3),
ADD COLUMN "worldFrozenAt" TIMESTAMP(3),
ADD COLUMN "worldFrozenReason" TEXT,
ADD COLUMN "worldCancelledAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "WorldAdminAudit" (
    "id" TEXT NOT NULL,
    "subjectWawuId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "stageBefore" TEXT NOT NULL,
    "stageAfter" TEXT NOT NULL,
    "actedByAdminId" TEXT NOT NULL,
    "actedByAdminEmail" TEXT NOT NULL,
    "actedByAdminRole" "AdminRole" NOT NULL,
    "actedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorldAdminAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FintavaWalletOpening_worldCountry_idx" ON "FintavaWalletOpening"("worldCountry");

-- CreateIndex
CREATE INDEX "WorldAdminAudit_subjectWawuId_idx" ON "WorldAdminAudit"("subjectWawuId");

-- CreateIndex
CREATE INDEX "WorldAdminAudit_actedByAdminId_idx" ON "WorldAdminAudit"("actedByAdminId");

-- CreateIndex
CREATE INDEX "WorldAdminAudit_actedAt_idx" ON "WorldAdminAudit"("actedAt");
