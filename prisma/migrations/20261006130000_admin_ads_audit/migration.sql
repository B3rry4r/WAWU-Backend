-- Admin ad management audit (task ADS-06, R-15).
--
-- Additive only: one new enum type and one new table. No existing table,
-- column, index or row is touched.
--
-- One row per admin change to an ad campaign, written in the same transaction
-- as the change. No foreign key to "AdCampaign" (a deleted draft keeps its
-- history) or to "AdminUser" (email and role are snapshots), the same idiom as
-- "AdminEventReview". No column names a WAWU user.
--
-- Rollback: DROP TABLE "AdminAdAudit"; DROP TYPE "AdminAdAction";
--           DELETE FROM "_prisma_migrations"
--            WHERE migration_name = '20261006130000_admin_ads_audit';

-- CreateEnum
CREATE TYPE "AdminAdAction" AS ENUM ('created', 'updated', 'scheduled', 'paused', 'resumed', 'ended', 'deleted');

-- CreateTable
CREATE TABLE "AdminAdAudit" (
    "id" TEXT NOT NULL,
    "seq" SERIAL NOT NULL,
    "campaignId" TEXT NOT NULL,
    "action" "AdminAdAction" NOT NULL,
    "previousStatus" "AdCampaignStatus",
    "newStatus" "AdCampaignStatus",
    "changes" JSONB,
    "adminId" TEXT NOT NULL,
    "adminEmail" TEXT NOT NULL,
    "adminRole" "AdminRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAdAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdminAdAudit_campaignId_seq_idx" ON "AdminAdAudit"("campaignId", "seq");

-- CreateIndex
CREATE INDEX "AdminAdAudit_adminId_idx" ON "AdminAdAudit"("adminId");
