-- NUV-02: opening a wallet on Nuvion. Additive only: nullable columns on
-- NuvionEntity (NUV-01's table, one row per person at Nuvion) for each check
-- of Nuvion's review in Nuvion's own words, when the entity was last read
-- back, when corrected details were sent after a refusal, Nuvion's own time
-- for the entity's last change (how a new decision is told from the echo of
-- our own correction), and the claim on the one naira account. No BVN, NIN
-- or document number is stored.
-- Round 3 (changed in place; no shared or production database has applied
-- this migration): when the person last submitted (`submittedAt`), when the
-- opening last moved along (`progressAt`), when it expired (`holdExpiredAt`),
-- the keyed hash of the caller's address on the opening tries of
-- `BvnCheckAttempt` (`addressKey`, with its index), and one value in each of
-- the two admin audit enums for support releasing a hold.
-- Rollback: DROP each column below, DROP INDEX "BvnCheckAttempt_addressKey_createdAt_idx"
-- (no other table is touched). The two enum values cannot be dropped in
-- Postgres without recreating the types: they are unused when rolled back and
-- are left in place.

-- AlterTable
ALTER TABLE "NuvionEntity" ADD COLUMN     "accountRequestedAt" TIMESTAMP(3),
ADD COLUMN     "addressProofStatus" TEXT,
ADD COLUMN     "bvnStatus" TEXT,
ADD COLUMN     "correctedAt" TIMESTAMP(3),
ADD COLUMN     "documentStatus" TEXT,
ADD COLUMN     "entityUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "holdExpiredAt" TIMESTAMP(3),
ADD COLUMN     "identificationStatus" TEXT,
ADD COLUMN     "ninStatus" TEXT,
ADD COLUMN     "progressAt" TIMESTAMP(3),
ADD COLUMN     "reviewReadAt" TIMESTAMP(3),
ADD COLUMN     "submittedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "BvnCheckAttempt" ADD COLUMN     "addressKey" TEXT;

-- CreateIndex
CREATE INDEX "BvnCheckAttempt_addressKey_createdAt_idx" ON "BvnCheckAttempt"("addressKey", "createdAt");

-- AlterEnum
ALTER TYPE "AdminOpsResource" ADD VALUE 'wallet_identity_hold';

-- AlterEnum
ALTER TYPE "AdminOpsAction" ADD VALUE 'wallet_identity_hold_released';
