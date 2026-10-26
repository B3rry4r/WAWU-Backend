-- PAY-FX (R-91): paying a naira price from another currency.
-- Additive only: one nullable column on WalletPayment and one new table.
-- Rollback (nothing reads either once the code is rolled back):
--   DROP TABLE "WalletPaymentFx"; ALTER TABLE "WalletPayment" DROP COLUMN "sourceCurrency";

-- AlterTable
ALTER TABLE "WalletPayment" ADD COLUMN "sourceCurrency" TEXT;

-- CreateTable
CREATE TABLE "WalletPaymentFx" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "sourceCurrency" TEXT NOT NULL,
    "fxAccountId" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "fxQuoteId" TEXT NOT NULL,
    "providerQuoteId" TEXT NOT NULL,
    "rate" TEXT NOT NULL,
    "sourceAmountMinor" BIGINT NOT NULL,
    "providerFeeMinor" BIGINT,
    "wawuFeeMinor" BIGINT NOT NULL DEFAULT 0,
    "feeLeg" TEXT,
    "providerTransferId" TEXT,
    "refundMinor" BIGINT,
    "refundCostKobo" BIGINT,
    "refundQuoteId" TEXT,
    "refundRate" TEXT,
    "refundTransferId" TEXT,
    "refundedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WalletPaymentFx_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WalletPaymentFx_paymentId_key" ON "WalletPaymentFx"("paymentId");

-- AddForeignKey
ALTER TABLE "WalletPaymentFx" ADD CONSTRAINT "WalletPaymentFx_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "WalletPayment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
