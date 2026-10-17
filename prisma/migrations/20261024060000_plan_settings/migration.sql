-- The new money figures as admin settings (task TIER-06, R-65).
--
-- Additive only: one new table and one new value in each of the two admin
-- audit enums. No existing column, index or row changes meaning.
--
-- PlanSetting: one row per setting key an admin has changed. A key with no
-- row reads its default from the seed files, so a fresh database holds no
-- rows and the app runs on the launch values. The key and the value are
-- checked by the registry in src/plan-settings before each write and on each
-- read; the CHECK only keeps a key from being empty or absurdly long.
--
-- Rollback: DROP TABLE "PlanSetting". The two enum values cannot be dropped in
-- Postgres without recreating the types: they are unused when rolled back and
-- are left in place.

-- CreateTable
CREATE TABLE "PlanSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedByAdminId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanSetting_pkey" PRIMARY KEY ("key"),
    CONSTRAINT "PlanSetting_key_bounded" CHECK (char_length("key") BETWEEN 1 AND 120)
);

-- CreateIndex
CREATE INDEX "PlanSetting_updatedAt_idx" ON "PlanSetting"("updatedAt");

-- AlterEnum
ALTER TYPE "AdminOpsResource" ADD VALUE 'plan_setting';

-- AlterEnum
ALTER TYPE "AdminOpsAction" ADD VALUE 'plan_setting_set';
