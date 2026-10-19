-- Referral points: invite, claim and earn (task REF-02, R-43, R-65).
--
-- Additive only: one new enum and four new tables. No existing column, index,
-- row or enum value changes meaning. The points themselves are POINTS-01 lots
-- (source `referral`, which already exists); these tables say who invited
-- whom and what each reward waits for.
--
-- What the database refuses, so no code path can break it:
--  - a person invited by themselves (CHECK on PersonReferral and ReferralReward);
--  - a second claim by one person (UNIQUE referredWawuUserId);
--  - a second reward for one referral (UNIQUE referralId): parallel tier
--    payments and repeated confirmations make one row, the first insert wins;
--  - a reward whose points are not its base points times its multiplier, or a
--    multiplier below x1 or above x10;
--  - a reward that is settled changing again, or a pending one changing its
--    figures (trigger);
--  - a milestone granted twice to one person (UNIQUE referrer + count).
-- The account purge deletes a person's rows (rewards first, then the claims).
--
-- Rollback: DROP TABLE "ReferralMilestone", "ReferralReward", "PersonReferral",
-- "PersonReferralCode"; DROP FUNCTION "ReferralReward_final"(); DROP TYPE
-- "ReferralRewardState". Points already granted stay in their lots.

-- CreateEnum
CREATE TYPE "ReferralRewardState" AS ENUM ('pending', 'granted', 'cancelled');

-- CreateTable
CREATE TABLE "PersonReferralCode" (
    "id" TEXT NOT NULL,
    "wawuUserId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PersonReferralCode_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PersonReferralCode_code_shape" CHECK ("code" ~ '^[A-Z0-9]{3,20}$')
);

-- CreateTable
CREATE TABLE "PersonReferral" (
    "id" TEXT NOT NULL,
    "referrerWawuUserId" TEXT NOT NULL,
    "referredWawuUserId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PersonReferral_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PersonReferral_not_self" CHECK ("referrerWawuUserId" <> "referredWawuUserId")
);

-- CreateTable
CREATE TABLE "ReferralReward" (
    "id" TEXT NOT NULL,
    "referralId" TEXT NOT NULL,
    "referrerWawuUserId" TEXT NOT NULL,
    "referredWawuUserId" TEXT NOT NULL,
    "paymentRef" TEXT NOT NULL,
    "tierId" TEXT NOT NULL,
    "basePoints" INTEGER NOT NULL,
    "multiplierMilli" INTEGER NOT NULL,
    "points" INTEGER NOT NULL,
    "state" "ReferralRewardState" NOT NULL DEFAULT 'pending',
    "availableAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),
    "cancelReason" TEXT,

    CONSTRAINT "ReferralReward_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ReferralReward_not_self" CHECK ("referrerWawuUserId" <> "referredWawuUserId"),
    CONSTRAINT "ReferralReward_base_whole" CHECK ("basePoints" >= 0),
    CONSTRAINT "ReferralReward_multiplier_bounded" CHECK ("multiplierMilli" BETWEEN 1000 AND 10000),
    CONSTRAINT "ReferralReward_points_exact" CHECK (
      "points" = (("basePoints"::bigint * "multiplierMilli"::bigint + 500) / 1000)
    ),
    CONSTRAINT "ReferralReward_state_shape" CHECK (
      ("state" = 'pending' AND "settledAt" IS NULL AND "cancelReason" IS NULL)
      OR ("state" = 'granted' AND "settledAt" IS NOT NULL AND "cancelReason" IS NULL AND "points" > 0)
      OR ("state" = 'cancelled' AND "settledAt" IS NOT NULL AND "cancelReason" IS NOT NULL)
    )
);

-- CreateTable
CREATE TABLE "ReferralMilestone" (
    "id" TEXT NOT NULL,
    "referrerWawuUserId" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "points" INTEGER NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralMilestone_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ReferralMilestone_positive" CHECK ("count" > 0 AND "points" > 0)
);

-- CreateIndex
CREATE UNIQUE INDEX "PersonReferralCode_wawuUserId_key" ON "PersonReferralCode"("wawuUserId");

-- CreateIndex
CREATE UNIQUE INDEX "PersonReferralCode_code_key" ON "PersonReferralCode"("code");

-- CreateIndex
CREATE UNIQUE INDEX "PersonReferral_referredWawuUserId_key" ON "PersonReferral"("referredWawuUserId");

-- CreateIndex
CREATE INDEX "PersonReferral_referrerWawuUserId_claimedAt_idx" ON "PersonReferral"("referrerWawuUserId", "claimedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralReward_referralId_key" ON "ReferralReward"("referralId");

-- CreateIndex
CREATE INDEX "ReferralReward_state_availableAt_idx" ON "ReferralReward"("state", "availableAt");

-- CreateIndex
CREATE INDEX "ReferralReward_referrerWawuUserId_state_idx" ON "ReferralReward"("referrerWawuUserId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralMilestone_referrerWawuUserId_count_key" ON "ReferralMilestone"("referrerWawuUserId", "count");

-- AddForeignKey
ALTER TABLE "ReferralReward" ADD CONSTRAINT "ReferralReward_referralId_fkey" FOREIGN KEY ("referralId") REFERENCES "PersonReferral"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A settled reward never changes, and a pending one changes only to settle:
-- its figures, its people and its payment are fixed when it is made.
CREATE FUNCTION "ReferralReward_final"() RETURNS trigger AS $$
BEGIN
  IF OLD."state" <> 'pending' THEN
    RAISE EXCEPTION 'A settled referral reward does not change (%).', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."referralId" IS DISTINCT FROM OLD."referralId"
     OR NEW."referrerWawuUserId" IS DISTINCT FROM OLD."referrerWawuUserId"
     OR NEW."referredWawuUserId" IS DISTINCT FROM OLD."referredWawuUserId"
     OR NEW."paymentRef" IS DISTINCT FROM OLD."paymentRef"
     OR NEW."tierId" IS DISTINCT FROM OLD."tierId"
     OR NEW."basePoints" IS DISTINCT FROM OLD."basePoints"
     OR NEW."multiplierMilli" IS DISTINCT FROM OLD."multiplierMilli"
     OR NEW."points" IS DISTINCT FROM OLD."points"
     OR NEW."availableAt" IS DISTINCT FROM OLD."availableAt" THEN
    RAISE EXCEPTION 'A referral reward keeps its figures (%).', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ReferralReward_final"
BEFORE UPDATE ON "ReferralReward"
FOR EACH ROW EXECUTE FUNCTION "ReferralReward_final"();
