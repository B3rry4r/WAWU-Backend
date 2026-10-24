-- NUV-12 (R-84): a person's Capital orders and the admin's acts on them.
-- Additive only: two new tables. The provider holds the order and the holding;
-- these rows are WAWU's side (the app's reservation key, the state shown, the
-- admin's freeze or cancel, the ledger links).

CREATE TABLE "CapitalOrder" (
    "id" TEXT NOT NULL,
    "wawuUserId" TEXT NOT NULL,
    "reserveKey" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'nuvion',
    "nuvionOrderId" TEXT,
    "productId" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "productType" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "totalDebitMinor" BIGINT,
    "feeKobo" BIGINT NOT NULL DEFAULT 0,
    "feeState" TEXT NOT NULL DEFAULT 'none',
    "feeReference" TEXT,
    "snapshot" JSONB,
    "expiresAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "capitalAccountId" TEXT,
    "userCapitalAccountId" TEXT,
    "lifecycle" TEXT,
    "payoutStatus" TEXT,
    "purchaseTransferId" TEXT,
    "payoutTransferId" TEXT,
    "withdrawRequestedAt" TIMESTAMP(3),
    "frozenAt" TIMESTAMP(3),
    "frozenReason" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CapitalOrder_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CapitalOrder_nuvionOrderId_key" ON "CapitalOrder"("nuvionOrderId");
CREATE UNIQUE INDEX "CapitalOrder_wawuUserId_reserveKey_key" ON "CapitalOrder"("wawuUserId", "reserveKey");
CREATE INDEX "CapitalOrder_wawuUserId_createdAt_idx" ON "CapitalOrder"("wawuUserId", "createdAt");
CREATE INDEX "CapitalOrder_state_updatedAt_idx" ON "CapitalOrder"("state", "updatedAt");
CREATE INDEX "CapitalOrder_userCapitalAccountId_idx" ON "CapitalOrder"("userCapitalAccountId");

CREATE TABLE "CapitalAdminAudit" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "subjectWawuId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "note" TEXT,
    "adminId" TEXT NOT NULL,
    "adminEmail" TEXT NOT NULL,
    "adminRole" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CapitalAdminAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CapitalAdminAudit_orderId_createdAt_idx" ON "CapitalAdminAudit"("orderId", "createdAt");
CREATE INDEX "CapitalAdminAudit_subjectWawuId_createdAt_idx" ON "CapitalAdminAudit"("subjectWawuId", "createdAt");
