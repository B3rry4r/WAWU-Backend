-- What a payment was quoted with, kept for its delivery (task TIER-06 round 2).
--
-- Additive only: one new nullable column, no default, no backfill. A payment
-- claimed before this column, and any kind that sets no terms, has NULL and is
-- delivered as before. A tier purchase writes the goods it was quoted with
-- (products, bonus points, days, bump points, expiry) so a plan changed while
-- the payment confirms never changes what the buyer is given.
--
-- Rollback: ALTER TABLE "WalletPayment" DROP COLUMN "terms". Code that does
-- not know the column ignores it.

-- AlterTable
ALTER TABLE "WalletPayment" ADD COLUMN IF NOT EXISTS "terms" JSONB;
