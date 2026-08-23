-- Paid-DM refunds: track where the MONEY is, separately from where the
-- message is. Additive only — every column is nullable or defaulted, so rows
-- written before this migration stay valid.

CREATE TYPE "DmRefundStatus" AS ENUM ('not_owed', 'owed', 'submitted', 'settled', 'failed');

ALTER TABLE "DirectMessage"
  ADD COLUMN "flutterwaveTxId"     TEXT,
  ADD COLUMN "responseWindowHours" INTEGER NOT NULL DEFAULT 24,
  ADD COLUMN "refundStatus"        "DmRefundStatus" NOT NULL DEFAULT 'not_owed',
  ADD COLUMN "refundReference"     TEXT,
  ADD COLUMN "refundedAt"          TIMESTAMP(3),
  ADD COLUMN "refundAttempts"      INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "refundError"         TEXT,
  ADD COLUMN "refundLockedAt"      TIMESTAMP(3);

CREATE INDEX "DirectMessage_refundStatus_refundLockedAt_idx"
  ON "DirectMessage" ("refundStatus", "refundLockedAt");

-- Rows already flipped to `refunded` by the old sweep were never actually
-- paid back — the sweep only ever wrote a log line. They are a real debt to
-- real people, so they are enrolled as `owed` rather than quietly marked
-- settled, and the executor will work through them like any other. Those
-- with no captured transaction id cannot be refunded by API and will land in
-- the finance queue as `failed`, which is the correct place for them: a
-- human has to move that money.
UPDATE "DirectMessage" SET "refundStatus" = 'owed' WHERE "status" = 'refunded';

ALTER TABLE "CreatorState"
  ADD COLUMN "dmResponseHours" INTEGER NOT NULL DEFAULT 24;
