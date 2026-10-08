-- INBOX-03. Additive only: three new tables, nothing existing is changed.

-- CreateTable
CREATE TABLE "PushToken" (
    "id" TEXT NOT NULL,
    "userWawuId" TEXT NOT NULL,
    "expoPushToken" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "deviceId" TEXT,
    "deviceLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disabledAt" TIMESTAMP(3),
    "disabledReason" TEXT,

    CONSTRAINT "PushToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushDelivery" (
    "id" TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "userWawuId" TEXT NOT NULL,
    "pushTokenId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "claimId" TEXT,
    "interruptedSend" BOOLEAN NOT NULL DEFAULT false,
    "ticketId" TEXT,
    "sentAt" TIMESTAMP(3),
    "receiptDueAt" TIMESTAMP(3),
    "receiptChecks" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PushDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushStoppedAccount" (
    "userWawuId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushStoppedAccount_pkey" PRIMARY KEY ("userWawuId")
);

-- CreateIndex
CREATE UNIQUE INDEX "PushToken_expoPushToken_key" ON "PushToken"("expoPushToken");

-- CreateIndex
CREATE INDEX "PushToken_userWawuId_idx" ON "PushToken"("userWawuId");

-- CreateIndex
CREATE INDEX "PushToken_disabledAt_idx" ON "PushToken"("disabledAt");

-- CreateIndex
CREATE INDEX "PushDelivery_status_nextAttemptAt_idx" ON "PushDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "PushDelivery_status_receiptDueAt_idx" ON "PushDelivery"("status", "receiptDueAt");

-- CreateIndex
CREATE INDEX "PushDelivery_userWawuId_idx" ON "PushDelivery"("userWawuId");

-- CreateIndex
CREATE UNIQUE INDEX "PushDelivery_notificationId_pushTokenId_key" ON "PushDelivery"("notificationId", "pushTokenId");

-- AddForeignKey
ALTER TABLE "PushDelivery" ADD CONSTRAINT "PushDelivery_pushTokenId_fkey" FOREIGN KEY ("pushTokenId") REFERENCES "PushToken"("id") ON DELETE CASCADE ON UPDATE CASCADE;
