-- Counting ad views, taps and skips (task ADS-05, R-15).
--
-- Additive only: one new enum type and two new tables. No existing table,
-- column, index or row is touched (the two relation fields on AdCampaign in
-- schema.prisma are back-references; they add no column).
--
--   "AdEvent"       one row per (campaign, person, kind, UTC day). The primary
--                   key is the dedupe rule: a second view, tap or skip by the
--                   same person on the same day cannot be stored.
--   "AdDailyTotal"  one row per (campaign, UTC day) with the three counts. The
--                   service moves it in the same statement that inserts an
--                   "AdEvent" row and only when that row was new, so the totals
--                   equal the raw rows.
--
-- Deleting a campaign that has been counted is refused (ON DELETE RESTRICT):
-- the counts are what the owner invoices from (R-15). A campaign that ran is
-- ended or paused, not deleted. (A campaign nobody has seen has no rows here
-- and deletes as before, taking its creative with it.)
--
-- "AdEvent"."viewerWawuId" names a person and is classified in
-- src/account-purge/account-data-map.ts (OWNED: deleted with the account).
-- "AdDailyTotal" names nobody and is kept.
--
-- Rollback: DROP TABLE "AdDailyTotal"; DROP TABLE "AdEvent";
--           DROP TYPE "AdEventType";
--           DELETE FROM "_prisma_migrations"
--            WHERE migration_name = '20261006133700_ads_event_counts';

-- CreateEnum
CREATE TYPE "AdEventType" AS ENUM ('view', 'tap', 'skip');

-- CreateTable
CREATE TABLE "AdEvent" (
    "campaignId" TEXT NOT NULL,
    "viewerWawuId" TEXT NOT NULL,
    "type" "AdEventType" NOT NULL,
    "day" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdEvent_pkey" PRIMARY KEY ("campaignId","viewerWawuId","type","day")
);

-- CreateTable
CREATE TABLE "AdDailyTotal" (
    "campaignId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "views" INTEGER NOT NULL DEFAULT 0,
    "taps" INTEGER NOT NULL DEFAULT 0,
    "skips" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AdDailyTotal_pkey" PRIMARY KEY ("campaignId","day")
);

-- CreateIndex
CREATE INDEX "AdEvent_campaignId_day_idx" ON "AdEvent"("campaignId", "day");

-- CreateIndex
CREATE INDEX "AdEvent_viewerWawuId_idx" ON "AdEvent"("viewerWawuId");

-- AddForeignKey
ALTER TABLE "AdEvent" ADD CONSTRAINT "AdEvent_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "AdCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdDailyTotal" ADD CONSTRAINT "AdDailyTotal_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "AdCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A count never goes below zero.
ALTER TABLE "AdDailyTotal" ADD CONSTRAINT "AdDailyTotal_counts_check" CHECK ("views" >= 0 AND "taps" >= 0 AND "skips" >= 0);
