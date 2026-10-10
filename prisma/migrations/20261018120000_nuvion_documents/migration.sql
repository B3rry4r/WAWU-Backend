-- NUV-03: ID document, proof of address and the hosted selfie on Nuvion.
-- Additive only: two new tables, no existing table is touched.
--   NuvionDocument: one row per person and kind (identity, proof_of_address):
--     the state, the sides sent, Nuvion's document id, the time and a keyed
--     fingerprint of the bytes (so the same file sent twice is forwarded
--     once). Never the file, a copy of it, or a number read off it. The
--     fingerprint is an HMAC under IDENTITY_HASH_KEY, cleared once the
--     opening is submitted; reviewRefusedAt keeps Nuvion's refusal of an
--     upload on the row itself, through a correction of the details.
--   NuvionOnboarding: one row per person: the claim on the one onboarding
--     submission, when it was made, and the hosted selfie's session and
--     result in one word.
-- Rollback: DROP TABLE "NuvionDocument"; DROP TABLE "NuvionOnboarding";

-- CreateTable
CREATE TABLE "NuvionDocument" (
    "wawuUserId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "sides" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "state" TEXT NOT NULL,
    "nuvionDocumentId" TEXT,
    "knownDocumentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "fingerprint" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "attemptStartedAt" TIMESTAMP(3) NOT NULL,
    "uploadedAt" TIMESTAMP(3),
    "reviewRefusedAt" TIMESTAMP(3),
    "failure" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NuvionDocument_pkey" PRIMARY KEY ("wawuUserId","kind")
);

-- CreateTable
CREATE TABLE "NuvionOnboarding" (
    "wawuUserId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "submitRequestedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "submitAttempts" INTEGER NOT NULL DEFAULT 0,
    "submitRefusedAt" TIMESTAMP(3),
    "livenessSessionId" TEXT,
    "livenessClaimedAt" TIMESTAMP(3),
    "livenessStartedAt" TIMESTAMP(3),
    "livenessLinkedAt" TIMESTAMP(3),
    "livenessState" TEXT,
    "livenessCheckedAt" TIMESTAMP(3),
    "livenessSessions" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NuvionOnboarding_pkey" PRIMARY KEY ("wawuUserId")
);

-- CreateIndex
CREATE INDEX "NuvionDocument_entityId_idx" ON "NuvionDocument"("entityId");

-- CreateIndex
CREATE INDEX "NuvionDocument_state_attemptStartedAt_idx" ON "NuvionDocument"("state", "attemptStartedAt");

-- CreateIndex
CREATE INDEX "NuvionOnboarding_submittedAt_idx" ON "NuvionOnboarding"("submittedAt");
