-- WALLET-25 and WALLET-26 (R-84): adding money by card, Apple Pay, USSD or a bank checkout.
-- Additive only: two new tables and nothing else. No existing table, column, index or row changes.

CREATE TABLE "AddMoneySession" (
    "id" TEXT NOT NULL,
    "wawuUserId" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'nuvion',
    "rail" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "amountKobo" BIGINT NOT NULL,
    "chargeKobo" BIGINT NOT NULL,
    "providerFeeKobo" BIGINT NOT NULL DEFAULT 0,
    "wawuFeeKobo" BIGINT NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'created',
    "frozen" BOOLEAN NOT NULL DEFAULT false,
    "reference" TEXT NOT NULL,
    "providerRef" TEXT,
    "actionRef" TEXT,
    "checkoutUrl" TEXT,
    "cardLast4" TEXT,
    "cardBrand" TEXT,
    "failureMessage" TEXT,
    "failureCode" TEXT,
    "ledgerEntryId" TEXT,
    "creditedAt" TIMESTAMP(3),
    "feeCollectedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "checkedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AddMoneySession_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AddMoneySession_rail_check" CHECK ("rail" IN ('card', 'apple_pay', 'ussd', 'open_banking')),
    CONSTRAINT "AddMoneySession_status_check" CHECK ("status" IN ('created', 'awaiting_user', 'processing', 'settled', 'failed', 'expired', 'cancelled')),
    CONSTRAINT "AddMoneySession_amount_check" CHECK ("amountKobo" > 0 AND "chargeKobo" >= "amountKobo")
);

CREATE TABLE "AddMoneyAudit" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT,
    "fromStatus" TEXT NOT NULL,
    "toStatus" TEXT NOT NULL,
    "actedByAdminId" TEXT NOT NULL,
    "actedByAdminEmail" TEXT NOT NULL,
    "actedByAdminRole" "AdminRole" NOT NULL,
    "actedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AddMoneyAudit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AddMoneySession_reference_key" ON "AddMoneySession"("reference");
CREATE INDEX "AddMoneySession_wawuUserId_createdAt_idx" ON "AddMoneySession"("wawuUserId", "createdAt");
CREATE INDEX "AddMoneySession_status_checkedAt_idx" ON "AddMoneySession"("status", "checkedAt");
CREATE INDEX "AddMoneySession_providerRef_idx" ON "AddMoneySession"("providerRef");
CREATE INDEX "AddMoneyAudit_sessionId_idx" ON "AddMoneyAudit"("sessionId");
CREATE INDEX "AddMoneyAudit_actedAt_idx" ON "AddMoneyAudit"("actedAt");

ALTER TABLE "AddMoneyAudit" ADD CONSTRAINT "AddMoneyAudit_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AddMoneySession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
