-- Creator wallets, held at Flutterwave MFB under Flutterwave's own banking
-- licence. None of these tables IS the balance: Flutterwave's is
-- authoritative, and these record what WAWU asked for and what it was told
-- happened, which is what makes "where did this money go" answerable.

CREATE TYPE "WalletEntryKind"   AS ENUM ('earning', 'withdrawal', 'reversal');
CREATE TYPE "WalletEntryStatus" AS ENUM ('pending', 'completed', 'failed');

CREATE TABLE "CreatorWallet" (
    "wawuUserId"       TEXT NOT NULL,
    "accountReference" TEXT NOT NULL,
    "barterId"         TEXT NOT NULL,
    "nuban"            TEXT,
    "bankName"         TEXT,
    "bankCode"         TEXT,
    "status"           TEXT NOT NULL DEFAULT 'active',
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CreatorWallet_pkey" PRIMARY KEY ("wawuUserId")
);
CREATE UNIQUE INDEX "CreatorWallet_accountReference_key" ON "CreatorWallet"("accountReference");
CREATE UNIQUE INDEX "CreatorWallet_barterId_key"         ON "CreatorWallet"("barterId");
CREATE INDEX        "CreatorWallet_status_idx"           ON "CreatorWallet"("status");

CREATE TABLE "WalletLedgerEntry" (
    "id"            TEXT NOT NULL,
    "wawuUserId"    TEXT NOT NULL,
    "kind"          "WalletEntryKind" NOT NULL,
    "amount"        INTEGER NOT NULL,
    "status"        "WalletEntryStatus" NOT NULL DEFAULT 'pending',
    "reference"     TEXT NOT NULL,
    "transferId"    TEXT,
    "sourceType"    TEXT,
    "sourceId"      TEXT,
    "failureReason" TEXT,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt"     TIMESTAMP(3),
    CONSTRAINT "WalletLedgerEntry_pkey" PRIMARY KEY ("id")
);
-- The idempotency key. A retried instruction finds this row rather than
-- moving the money a second time.
CREATE UNIQUE INDEX "WalletLedgerEntry_reference_key"      ON "WalletLedgerEntry"("reference");
CREATE INDEX "WalletLedgerEntry_wawuUserId_createdAt_idx"  ON "WalletLedgerEntry"("wawuUserId", "createdAt");
CREATE INDEX "WalletLedgerEntry_status_idx"                ON "WalletLedgerEntry"("status");
CREATE INDEX "WalletLedgerEntry_sourceType_sourceId_idx"   ON "WalletLedgerEntry"("sourceType", "sourceId");

CREATE TABLE "WalletWithdrawal" (
    "id"            TEXT NOT NULL,
    "wawuUserId"    TEXT NOT NULL,
    "entryId"       TEXT NOT NULL,
    "amount"        INTEGER NOT NULL,
    "bankCode"      TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "accountName"   TEXT NOT NULL,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WalletWithdrawal_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WalletWithdrawal_entryId_key"             ON "WalletWithdrawal"("entryId");
CREATE INDEX "WalletWithdrawal_wawuUserId_createdAt_idx"       ON "WalletWithdrawal"("wawuUserId", "createdAt");
