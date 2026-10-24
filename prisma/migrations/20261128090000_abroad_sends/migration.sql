-- NUV-11 (R-84). Sending money abroad: five new tables (saved recipients, held quotes, sends, a freeze per person,
-- an audit of admin acts). Additive only: nothing the web, the dashboard or the app calls today reads or writes them.
-- The account of a recipient stays with the provider; only its last four characters and a fingerprint are kept.

-- CreateTable
CREATE TABLE "AbroadRecipient" (
    "id" TEXT NOT NULL,
    "wawuUserId" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "scheme" TEXT,
    "holderName" TEXT NOT NULL,
    "bankName" TEXT,
    "last4" TEXT,
    "fingerprint" TEXT NOT NULL,
    "providerCounterpartyId" TEXT NOT NULL,
    "providerPaymentDetailId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "AbroadRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AbroadQuote" (
    "id" TEXT NOT NULL,
    "wawuUserId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "fromCurrency" TEXT NOT NULL,
    "toCurrency" TEXT NOT NULL,
    "fromAccountRef" TEXT NOT NULL,
    "amountFromMinor" BIGINT NOT NULL,
    "amountToMinor" BIGINT NOT NULL,
    "rate" TEXT,
    "providerQuoteId" TEXT,
    "wawuFeeKobo" BIGINT NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AbroadQuote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AbroadSend" (
    "id" TEXT NOT NULL,
    "wawuUserId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "fromCurrency" TEXT NOT NULL,
    "toCurrency" TEXT NOT NULL,
    "fromAccountRef" TEXT NOT NULL,
    "amountFromMinor" BIGINT NOT NULL,
    "amountToMinor" BIGINT NOT NULL,
    "rate" TEXT,
    "status" TEXT NOT NULL,
    "failureReason" TEXT,
    "narration" TEXT,
    "reference" TEXT NOT NULL,
    "providerTransferId" TEXT,
    "providerStatus" TEXT,
    "providerFeeMinor" BIGINT,
    "wawuFeeKobo" BIGINT NOT NULL DEFAULT 0,
    "wawuFeeTaken" BOOLEAN NOT NULL DEFAULT true,
    "feeAttempts" INTEGER NOT NULL DEFAULT 0,
    "attemptedAt" TIMESTAMP(3),
    "checkedAt" TIMESTAMP(3),
    "checks" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AbroadSend_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AbroadFreeze" (
    "wawuUserId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "byAdminId" TEXT NOT NULL,
    "frozenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AbroadFreeze_pkey" PRIMARY KEY ("wawuUserId")
);

-- CreateTable
CREATE TABLE "AbroadAdminAudit" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "subjectWawuId" TEXT NOT NULL,
    "sendId" TEXT,
    "reason" TEXT NOT NULL,
    "detail" JSONB,
    "adminId" TEXT NOT NULL,
    "adminEmail" TEXT NOT NULL,
    "adminRole" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AbroadAdminAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AbroadRecipient_wawuUserId_removedAt_createdAt_idx" ON "AbroadRecipient"("wawuUserId", "removedAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AbroadRecipient_wawuUserId_fingerprint_key" ON "AbroadRecipient"("wawuUserId", "fingerprint");

-- CreateIndex
CREATE INDEX "AbroadQuote_wawuUserId_createdAt_idx" ON "AbroadQuote"("wawuUserId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AbroadSend_quoteId_key" ON "AbroadSend"("quoteId");

-- CreateIndex
CREATE UNIQUE INDEX "AbroadSend_reference_key" ON "AbroadSend"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "AbroadSend_providerTransferId_key" ON "AbroadSend"("providerTransferId");

-- CreateIndex
CREATE INDEX "AbroadSend_wawuUserId_createdAt_idx" ON "AbroadSend"("wawuUserId", "createdAt");

-- CreateIndex
CREATE INDEX "AbroadSend_status_updatedAt_idx" ON "AbroadSend"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "AbroadAdminAudit_subjectWawuId_at_idx" ON "AbroadAdminAudit"("subjectWawuId", "at");

-- CreateIndex
CREATE INDEX "AbroadAdminAudit_sendId_idx" ON "AbroadAdminAudit"("sendId");

-- AddForeignKey
ALTER TABLE "AbroadQuote" ADD CONSTRAINT "AbroadQuote_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "AbroadRecipient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AbroadSend" ADD CONSTRAINT "AbroadSend_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "AbroadRecipient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AbroadSend" ADD CONSTRAINT "AbroadSend_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "AbroadQuote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

