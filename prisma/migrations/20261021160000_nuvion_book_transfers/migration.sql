-- Book transfers on Nuvion (task NUV-05, R-42).
--
-- Additive only: one new table, "NuvionBookTransfer". No existing table,
-- column, index or row changes, and nothing is backfilled: no book transfer
-- could be sent on Nuvion before this task.
--
-- NuvionBookTransfer: the log of every book transfer this server sends on
-- Nuvion (a payment from a person's wallet into WAWU's operational account, a
-- release or a refund out of it, a send between two people). Nuvion has no
-- lookup by our reference, so the id of every transfer whose answer was read
-- is kept here beside our reference, and a transfer whose answer was lost is
-- found again from this row (which accounts, which amount, since when) by
-- walking the sender's transfers at Nuvion. The row is written BEFORE the
-- send. "reference" is unique: one reference is one row on every server.
--
-- What the database refuses, so the rules hold whatever the code does:
--   * a reference that is empty or longer than the 64 characters Nuvion takes
--     as "unique_reference";
--   * an amount that is not above zero, or a charge below zero;
--   * a transfer from an account to itself;
--   * a status other than the words below: "sending" (no answer read yet),
--     "refused" (Nuvion answered that it made nothing), or Nuvion's own
--     "pending", "processing", "successful", "failed", "reversed".
--
-- Rollback: DROP TABLE "NuvionBookTransfer";

-- CreateTable
CREATE TABLE "NuvionBookTransfer" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "nuvionId" TEXT,
    "fromAccountId" TEXT NOT NULL,
    "fromEntityId" TEXT,
    "fromOperational" BOOLEAN NOT NULL DEFAULT false,
    "fromAccountNumber" TEXT NOT NULL,
    "toAccountId" TEXT NOT NULL,
    "toEntityId" TEXT,
    "toOperational" BOOLEAN NOT NULL DEFAULT false,
    "toAccountNumber" TEXT NOT NULL,
    "toNuvionBan" TEXT NOT NULL,
    "amountKobo" BIGINT NOT NULL,
    "feeKobo" BIGINT,
    "narration" TEXT,
    "status" TEXT NOT NULL DEFAULT 'sending',
    "statusReason" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answeredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NuvionBookTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NuvionBookTransfer_reference_key" ON "NuvionBookTransfer"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "NuvionBookTransfer_nuvionId_key" ON "NuvionBookTransfer"("nuvionId");

-- CreateIndex
CREATE INDEX "NuvionBookTransfer_fromAccountId_sentAt_idx" ON "NuvionBookTransfer"("fromAccountId", "sentAt");

-- CreateIndex
CREATE INDEX "NuvionBookTransfer_toAccountId_idx" ON "NuvionBookTransfer"("toAccountId");

-- AddCheck
ALTER TABLE "NuvionBookTransfer"
  ADD CONSTRAINT "NuvionBookTransfer_reference_len"
    CHECK (char_length("reference") BETWEEN 1 AND 64),
  ADD CONSTRAINT "NuvionBookTransfer_amount_positive"
    CHECK ("amountKobo" > 0),
  ADD CONSTRAINT "NuvionBookTransfer_fee_not_negative"
    CHECK ("feeKobo" IS NULL OR "feeKobo" >= 0),
  ADD CONSTRAINT "NuvionBookTransfer_two_accounts"
    CHECK ("fromAccountId" <> "toAccountId"),
  ADD CONSTRAINT "NuvionBookTransfer_status_known"
    CHECK ("status" IN ('sending', 'refused', 'pending', 'processing', 'successful', 'failed', 'reversed'));
