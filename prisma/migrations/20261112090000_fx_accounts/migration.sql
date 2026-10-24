-- CreateTable
CREATE TABLE "FxAccount" (
    "id" TEXT NOT NULL,
    "wawuUserId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'nuvion',
    "currency" TEXT NOT NULL,
    "chain" TEXT NOT NULL DEFAULT '',
    "providerCustomerId" TEXT NOT NULL,
    "providerAccountId" TEXT,
    "ban" TEXT,
    "detailsId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'opening',
    "frozenAt" TIMESTAMP(3),
    "frozenReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FxAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FxQuote" (
    "id" TEXT NOT NULL,
    "wawuUserId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'nuvion',
    "providerQuoteId" TEXT NOT NULL,
    "fromCurrency" TEXT NOT NULL,
    "toCurrency" TEXT NOT NULL,
    "fromAccountId" TEXT,
    "toAccountId" TEXT,
    "amountFromMinor" BIGINT NOT NULL,
    "amountToMinor" BIGINT NOT NULL,
    "rate" TEXT NOT NULL,
    "providerFeeMinor" BIGINT,
    "wawuFeeMinor" BIGINT NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FxQuote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FxOperation" (
    "id" TEXT NOT NULL,
    "wawuUserId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'nuvion',
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reference" TEXT NOT NULL,
    "fromCurrency" TEXT NOT NULL,
    "toCurrency" TEXT,
    "fromAccountId" TEXT,
    "toAccountId" TEXT,
    "amountFromMinor" BIGINT NOT NULL,
    "amountToMinor" BIGINT,
    "rate" TEXT,
    "providerFeeMinor" BIGINT,
    "wawuFeeMinor" BIGINT NOT NULL DEFAULT 0,
    "quoteId" TEXT,
    "chain" TEXT,
    "address" TEXT,
    "providerTransferId" TEXT,
    "failureReason" TEXT,
    "ledgerAt" TIMESTAMP(3),
    "feeLeg" TEXT,
    "day" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "FxOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FxMovement" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'nuvion',
    "providerTransferId" TEXT NOT NULL,
    "wawuUserId" TEXT NOT NULL,
    "fxAccountId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "feeMinor" BIGINT NOT NULL DEFAULT 0,
    "paymentType" TEXT,
    "reference" TEXT,
    "eventId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FxMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FxAdminAudit" (
    "id" TEXT NOT NULL,
    "fxAccountId" TEXT NOT NULL,
    "subjectWawuId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "actedByAdminId" TEXT NOT NULL,
    "actedByAdminEmail" TEXT NOT NULL,
    "actedByAdminRole" "AdminRole" NOT NULL,
    "actedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FxAdminAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FxAccount_wawuUserId_idx" ON "FxAccount"("wawuUserId");

-- CreateIndex
CREATE INDEX "FxAccount_status_idx" ON "FxAccount"("status");

-- CreateIndex
CREATE UNIQUE INDEX "FxAccount_wawuUserId_provider_currency_chain_key" ON "FxAccount"("wawuUserId", "provider", "currency", "chain");

-- CreateIndex
CREATE UNIQUE INDEX "FxAccount_provider_providerAccountId_key" ON "FxAccount"("provider", "providerAccountId");

-- CreateIndex
CREATE INDEX "FxQuote_wawuUserId_createdAt_idx" ON "FxQuote"("wawuUserId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "FxOperation_reference_key" ON "FxOperation"("reference");

-- CreateIndex
CREATE INDEX "FxOperation_wawuUserId_createdAt_idx" ON "FxOperation"("wawuUserId", "createdAt");

-- CreateIndex
CREATE INDEX "FxOperation_status_createdAt_idx" ON "FxOperation"("status", "createdAt");

-- CreateIndex
CREATE INDEX "FxOperation_wawuUserId_fromCurrency_day_idx" ON "FxOperation"("wawuUserId", "fromCurrency", "day");

-- CreateIndex
CREATE INDEX "FxMovement_wawuUserId_occurredAt_idx" ON "FxMovement"("wawuUserId", "occurredAt");

-- CreateIndex
CREATE INDEX "FxMovement_fxAccountId_occurredAt_idx" ON "FxMovement"("fxAccountId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "FxMovement_provider_providerTransferId_key" ON "FxMovement"("provider", "providerTransferId");

-- CreateIndex
CREATE INDEX "FxAdminAudit_fxAccountId_idx" ON "FxAdminAudit"("fxAccountId");

-- CreateIndex
CREATE INDEX "FxAdminAudit_actedByAdminId_idx" ON "FxAdminAudit"("actedByAdminId");

-- CreateIndex
CREATE INDEX "FxAdminAudit_actedAt_idx" ON "FxAdminAudit"("actedAt");

