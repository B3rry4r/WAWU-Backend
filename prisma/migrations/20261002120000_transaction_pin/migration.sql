-- The transaction PIN (task MONEY-09).
--
-- Additive only: one new table and nothing else. Nobody has a row until they
-- set a PIN, so every existing person reads as "no PIN yet" and the web, which
-- never calls the PIN routes, is unaffected. The PIN is stored only as an
-- argon2id hash with its own salt.
CREATE TABLE "TransactionPin" (
    "wawuUserId" TEXT NOT NULL,
    "pinHash" TEXT NOT NULL,
    "failedTries" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TransactionPin_pkey" PRIMARY KEY ("wawuUserId")
);
