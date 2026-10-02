-- Who opens a wallet: the BVN check (task KYC-01).
--
-- Additive only: two new tables and nothing else. No full BVN or NIN is ever
-- written here: a keyed hash (HMAC-SHA256 under IDENTITY_HASH_KEY) and the
-- last 4 digits of each, the time the BVN check passed, the account phone that
-- matched it, and the occupation typed on A5. Nobody has a row until they run
-- the check in Open your wallet (R-6), so every existing person and every
-- existing route is unaffected.
CREATE TABLE "WalletIdentity" (
    "wawuUserId" TEXT NOT NULL,
    "bvnHash" TEXT,
    "bvnLast4" TEXT,
    "bvnVerifiedAt" TIMESTAMP(3),
    "ninHash" TEXT,
    "ninLast4" TEXT,
    "verifiedPhone" TEXT,
    "occupation" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WalletIdentity_pkey" PRIMARY KEY ("wawuUserId")
);

-- One row per BVN check sent to Fintava (each is charged): the per-person
-- daily limit is counted from it. It holds no part of the BVN.
CREATE TABLE "BvnCheckAttempt" (
    "id" TEXT NOT NULL,
    "wawuUserId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BvnCheckAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BvnCheckAttempt_wawuUserId_createdAt_idx" ON "BvnCheckAttempt"("wawuUserId", "createdAt");
