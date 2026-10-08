-- NUV-02: opening a wallet on Nuvion. Additive only: nullable columns on
-- NuvionEntity (NUV-01's table, one row per person at Nuvion) for each check
-- of Nuvion's review in Nuvion's own words, when the entity was last read
-- back, when corrected details were sent after a refusal, and the claim on
-- the one naira account. No BVN, NIN or document number is stored.
-- Rollback: DROP each column below (no other table is touched).

-- AlterTable
ALTER TABLE "NuvionEntity" ADD COLUMN     "accountRequestedAt" TIMESTAMP(3),
ADD COLUMN     "addressProofStatus" TEXT,
ADD COLUMN     "bvnStatus" TEXT,
ADD COLUMN     "correctedAt" TIMESTAMP(3),
ADD COLUMN     "documentStatus" TEXT,
ADD COLUMN     "identificationStatus" TEXT,
ADD COLUMN     "ninStatus" TEXT,
ADD COLUMN     "reviewReadAt" TIMESTAMP(3);
