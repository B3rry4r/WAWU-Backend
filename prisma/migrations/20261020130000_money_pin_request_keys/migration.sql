-- WALLET-06 round 2 (D1): the answer to a PIN change or a PIN reset, kept under
-- the caller's optional Idempotency-Key.
--
-- Additive: one new table, no existing table, column, index or row is touched.
-- PUT /money/pin and POST /money/pin/reset/confirm take an optional
-- Idempotency-Key; without it nothing is written here. With it, one row per
-- (person, route, key): written `in_progress` before the PIN is checked, and
-- turned `done` with the answer in the same transaction that changes the PIN.
-- The fingerprint is an argon2id hash of the request body (the body holds the
-- new PIN); the body itself is never stored. Rows are kept PIN_KEY_KEEP_HOURS
-- (48) and go with the account.
--
-- This folder sorts after every folder on backend main (newest 20261019120000)
-- and after the open branches' stamps (INBOX-05 20261020120000).
--
-- Rollback (nothing references the table; also in rollback.sql):
--   DROP TABLE "MoneyPinRequestKey";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261020130000_money_pin_request_keys';

-- CreateTable
CREATE TABLE "MoneyPinRequestKey" (
    "wawuUserId" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'in_progress',
    "claimId" TEXT NOT NULL,
    "responseStatus" INTEGER,
    "responseBody" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MoneyPinRequestKey_pkey" PRIMARY KEY ("wawuUserId","route","key")
);

-- CreateIndex
CREATE INDEX "MoneyPinRequestKey_updatedAt_idx" ON "MoneyPinRequestKey"("updatedAt");
