-- The selfie match to the BVN photo (task KYC-02).
--
-- Additive only: one new table and nothing else. One row per selfie match
-- sent to Fintava (each is charged, even when the faces do not match): the
-- per-person daily limit is counted from it, and it records the outcome, when
-- the answer came, and Fintava's confidence score when it gives one. It never
-- holds the selfie, the BVN photo or any part of the BVN. Nobody has a row
-- until they take the selfie in Open your wallet (R-6), so every existing
-- person and every existing route is unaffected.
--
-- Rollback: DROP TABLE "SelfieMatchAttempt";
CREATE TABLE "SelfieMatchAttempt" (
    "id" TEXT NOT NULL,
    "wawuUserId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL DEFAULT 'pending',
    "confidence" DOUBLE PRECISION,
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SelfieMatchAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SelfieMatchAttempt_wawuUserId_createdAt_idx" ON "SelfieMatchAttempt"("wawuUserId", "createdAt");
