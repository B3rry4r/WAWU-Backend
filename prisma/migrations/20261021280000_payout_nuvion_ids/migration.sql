-- NUV-06: sending to a bank and paying out on Nuvion. Additive only: nullable
-- columns on the two tables of saved bank accounts (WALLET-14).
--
-- MoneyBeneficiary and MoneyPayoutAccount hold, for an account that has been
-- sent to through Nuvion:
--   "nuvionBankCode"   the bank's code in Nuvion's list (an account saved in
--                      the Fintava days holds Fintava's code in "bankCode";
--                      it is matched to Nuvion's list by code, else by the
--                      bank's name, and kept here);
--   "nuvionCheckedAt"  when the holder's name was last confirmed through
--                      Nuvion; null on a row from the Fintava days, which is
--                      checked by name again before its first Nuvion send;
--   "nuvionCounterpartyId", "nuvionPaymentDetailId"
--                      Nuvion's counterparty and bank payment detail under the
--                      sender's entity, made by the first send and reused by
--                      every later one (provider ids, never a personal detail).
-- MoneyPayoutAccount also holds the same two ids as a payee of WAWU's
-- operational account ("nuvionOperationalCounterpartyId",
-- "nuvionOperationalPaymentDetailId"): a counterparty belongs to the entity
-- that pays, so WAWU's payouts to a person use their own pair.
--
-- No existing column, row or index is touched; every new column is NULL for a
-- row that exists today. Rollback: DROP each column below (no other table is
-- touched).

-- AlterTable
ALTER TABLE "MoneyBeneficiary" ADD COLUMN     "nuvionBankCode" TEXT,
ADD COLUMN     "nuvionCheckedAt" TIMESTAMP(3),
ADD COLUMN     "nuvionCounterpartyId" TEXT,
ADD COLUMN     "nuvionPaymentDetailId" TEXT;

-- AlterTable
ALTER TABLE "MoneyPayoutAccount" ADD COLUMN     "nuvionBankCode" TEXT,
ADD COLUMN     "nuvionCheckedAt" TIMESTAMP(3),
ADD COLUMN     "nuvionCounterpartyId" TEXT,
ADD COLUMN     "nuvionOperationalCounterpartyId" TEXT,
ADD COLUMN     "nuvionOperationalPaymentDetailId" TEXT,
ADD COLUMN     "nuvionPaymentDetailId" TEXT;
