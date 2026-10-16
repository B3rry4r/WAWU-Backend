-- Buy event tickets from the wallet (task EVENTS-07).
--
-- Additive only: seven nullable columns on "EventOrder" and one new table.
-- No existing column, index or row changes meaning, and the web's
-- Flutterwave orders keep "flutterwaveTxRef" and "flutterwaveTxId" as they are.
--
-- "EventOrder": "paymentProvider" is 'wallet' for an order paid from the
-- buyer's WAWU wallet and null for the web's; "paymentReference" is the
-- reference a person quotes, provider-neutral (the order reference stops
-- being Flutterwave-specific); "walletPaymentId" and "holdId" link the order
-- to the wallet payment that paid it and the hold its price waits in until
-- the event (R-19); "paidAt", "failureReason" and "requestKey" (the buyer's
-- optional Idempotency-Key on creation, unique per buyer) complete it.
--
-- "EventOrderLine": the basket (E2), one row per tier in an order, so a
-- Regular and a VIP ticket are bought in one payment. The name and the
-- price are snapshotted.
--
-- Rollback: DROP TABLE "EventOrderLine"; DROP INDEX "EventOrder_buyerWawuId_requestKey_key"; DROP INDEX "EventOrder_walletPaymentId_key"; DROP INDEX "EventOrder_paymentReference_key"; ALTER TABLE "EventOrder" DROP COLUMN "requestKey", DROP COLUMN "walletPaymentId", DROP COLUMN "holdId", DROP COLUMN "paymentReference", DROP COLUMN "paymentProvider", DROP COLUMN "failureReason", DROP COLUMN "paidAt";

-- AlterTable
ALTER TABLE "EventOrder" ADD COLUMN     "failureReason" TEXT,
ADD COLUMN     "holdId" TEXT,
ADD COLUMN     "paidAt" TIMESTAMP(3),
ADD COLUMN     "paymentProvider" TEXT,
ADD COLUMN     "paymentReference" TEXT,
ADD COLUMN     "requestKey" TEXT,
ADD COLUMN     "walletPaymentId" TEXT;

-- CreateTable
CREATE TABLE "EventOrderLine" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "ticketTypeId" TEXT NOT NULL,
    "tierName" TEXT NOT NULL,
    "unitPriceNaira" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EventOrderLine_ticketTypeId_idx" ON "EventOrderLine"("ticketTypeId");

-- CreateIndex
CREATE UNIQUE INDEX "EventOrderLine_orderId_ticketTypeId_key" ON "EventOrderLine"("orderId", "ticketTypeId");

-- CreateIndex
CREATE UNIQUE INDEX "EventOrder_paymentReference_key" ON "EventOrder"("paymentReference");

-- CreateIndex
CREATE UNIQUE INDEX "EventOrder_walletPaymentId_key" ON "EventOrder"("walletPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "EventOrder_buyerWawuId_requestKey_key" ON "EventOrder"("buyerWawuId", "requestKey");

-- AddForeignKey
ALTER TABLE "EventOrderLine" ADD CONSTRAINT "EventOrderLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "EventOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventOrderLine" ADD CONSTRAINT "EventOrderLine_ticketTypeId_fkey" FOREIGN KEY ("ticketTypeId") REFERENCES "EventTicketType"("id") ON DELETE CASCADE ON UPDATE CASCADE;
