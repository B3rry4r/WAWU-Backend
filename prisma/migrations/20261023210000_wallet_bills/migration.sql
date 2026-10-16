-- Pay bills from the wallet (task BILLS-04).
--
-- Additive only: one new table. No existing column, index or row changes
-- meaning. The web's Flutterwave bills ("BillPayment") are untouched.
--
-- WalletBill: one row per bill paid from the wallet (electricity, airtime,
-- data, cable TV). It is the target of a "bill" wallet payment; the money is the
-- payment's and its hold's. "purchaseSentAt" set means the purchase was handed
-- to Fintava, whose bill calls take no reference of ours: it is asked about and
-- never sent again until Fintava's own record says.
--
-- Rollback: DROP INDEX "WalletBill_fintavaReference_key"; DROP INDEX "WalletBill_fintavaTransactionId_key"; DROP TABLE "WalletBill";

-- CreateTable
CREATE TABLE "WalletBill" (
    "id" TEXT NOT NULL,
    "wawuUserId" TEXT,
    "category" TEXT NOT NULL,
    "billerCode" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "planType" TEXT,
    "productCode" TEXT,
    "productLabel" TEXT,
    "accountNumber" TEXT,
    "accountName" TEXT,
    "amountKobo" BIGINT NOT NULL,
    "billChargeKobo" BIGINT NOT NULL,
    "serviceFeeKobo" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "reference" TEXT NOT NULL,
    "paymentId" TEXT,
    "holdId" TEXT,
    "purchaseSentAt" TIMESTAMP(3),
    "checks" INTEGER NOT NULL DEFAULT 0,
    "fintavaTransactionId" TEXT,
    "fintavaReference" TEXT,
    "token" TEXT,
    "units" TEXT,
    "failureReason" TEXT,
    "paidAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WalletBill_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WalletBill_reference_key" ON "WalletBill"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "WalletBill_paymentId_key" ON "WalletBill"("paymentId");

-- CreateIndex
-- One Fintava record settles at most one bill (nulls are not equal, so bills
-- not yet bought do not clash).
CREATE UNIQUE INDEX "WalletBill_fintavaTransactionId_key" ON "WalletBill"("fintavaTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "WalletBill_fintavaReference_key" ON "WalletBill"("fintavaReference");

-- CreateIndex
CREATE INDEX "WalletBill_wawuUserId_createdAt_idx" ON "WalletBill"("wawuUserId", "createdAt");

-- CreateIndex
CREATE INDEX "WalletBill_status_purchaseSentAt_idx" ON "WalletBill"("status", "purchaseSentAt");
