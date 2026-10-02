-- Ties each selfie match to the BVN check it was compared against (task
-- KYC-02, verifier round 1, defect 2).
--
-- Additive only: two nullable columns on the table KYC-02 added in
-- 20261002210000_selfie_match, nothing else. Each selfie match records the
-- passed BVN check it was compared against, read once at the start of the
-- request: when that check passed (WalletIdentity.bvnVerifiedAt) and the
-- keyed hash of its BVN (WalletIdentity.bvnHash; never the BVN itself). A
-- match counts only while both equal the person's current check, so a
-- selfie matched against one BVN cannot count for another BVN whose check
-- passed while the selfie was being matched. A row written before these
-- columns existed has nulls and never counts as a match (the safe side).
--
-- Rollback: ALTER TABLE "SelfieMatchAttempt" DROP COLUMN "bvnHash", DROP COLUMN "bvnVerifiedAt";
ALTER TABLE "SelfieMatchAttempt" ADD COLUMN "bvnVerifiedAt" TIMESTAMP(3),
ADD COLUMN "bvnHash" TEXT;
