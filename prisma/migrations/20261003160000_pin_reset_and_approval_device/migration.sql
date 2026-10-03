-- Resetting the transaction PIN by a code to the phone, and the phone that may
-- approve with a fingerprint or a face (task MONEY-14).
--
-- Additive only: three new tables and their indexes, nothing else. Nobody has
-- a row until they ask for a reset code or register a phone, so the web, which
-- calls none of these routes, is unaffected. The code is stored only as an
-- argon2id hash; the phone's key is a public key.
CREATE TABLE "TransactionPinReset" (
    "id" TEXT NOT NULL,
    "wawuUserId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "failedTries" INTEGER NOT NULL DEFAULT 0,
    "sendState" TEXT NOT NULL DEFAULT 'sending',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "resendAvailableAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TransactionPinReset_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ApprovalDevice" (
    "wawuUserId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "biometric" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApprovalDevice_pkey" PRIMARY KEY ("wawuUserId")
);

CREATE TABLE "ApprovalChallenge" (
    "id" TEXT NOT NULL,
    "wawuUserId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "challenge" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalChallenge_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TransactionPinReset_wawuUserId_createdAt_idx" ON "TransactionPinReset"("wawuUserId", "createdAt");

CREATE INDEX "TransactionPinReset_phone_createdAt_idx" ON "TransactionPinReset"("phone", "createdAt");

CREATE UNIQUE INDEX "ApprovalDevice_deviceId_key" ON "ApprovalDevice"("deviceId");

CREATE INDEX "ApprovalChallenge_wawuUserId_createdAt_idx" ON "ApprovalChallenge"("wawuUserId", "createdAt");
