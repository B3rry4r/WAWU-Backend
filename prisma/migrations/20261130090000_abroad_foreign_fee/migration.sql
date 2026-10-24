-- WALLET-42. Sending abroad from a foreign account: WAWU's fee is taken from that account, in its own currency. The fee in the
-- sending currency's smallest unit, on the quote and on the send (0 when the fee is the naira wallet's `wawuFeeKobo`). Additive only:
-- one column with a default on each of the two tables created by 20261128090000_abroad_sends.

-- AlterTable
ALTER TABLE "AbroadQuote" ADD COLUMN     "wawuFeeMinor" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "AbroadSend" ADD COLUMN     "wawuFeeMinor" BIGINT NOT NULL DEFAULT 0;
