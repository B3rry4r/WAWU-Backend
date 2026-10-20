-- TIER-07: the number on a numbered tier badge ("Founding Maker #128", G-421).
--
-- Additive: one nullable column with a unique index on "MakerTier", and one new
-- one-row table. No existing column, index or row is renamed or retyped, and
-- no live response gains a key (the app reads the number through new fields).
--
-- A numbered badge belongs to the Founding Maker tier (`founding` in
-- src/plans/plans.config.json, `badge.numbered: true`). Anyone who already holds
-- that tier (bought or claimed before this migration) is numbered here, oldest
-- first, so no Founding Maker is shown without a number. The counter then
-- starts after the last one. Later grants take the next number in the same
-- transaction that writes the tier (src/plans/tier-grant.service.ts).
--
-- Rollback:
--   DROP TABLE "BadgeNumberCounter";
--   DROP INDEX "MakerTier_badgeNumber_key";
--   ALTER TABLE "MakerTier" DROP COLUMN "badgeNumber";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261024090000_maker_badge_number';

-- AlterTable
ALTER TABLE "MakerTier" ADD COLUMN "badgeNumber" INTEGER;

-- CreateTable
CREATE TABLE "BadgeNumberCounter" (
    "name" TEXT NOT NULL,
    "last" INTEGER NOT NULL,

    CONSTRAINT "BadgeNumberCounter_pkey" PRIMARY KEY ("name"),
    CONSTRAINT "BadgeNumberCounter_last_check" CHECK ("last" >= 0)
);

-- Number the Founding Makers that exist now, oldest first.
UPDATE "MakerTier" AS m
SET "badgeNumber" = n."rank"
FROM (
    SELECT "wawuUserId", ROW_NUMBER() OVER (ORDER BY "createdAt", "wawuUserId") AS "rank"
    FROM "MakerTier"
    WHERE "tierId" = 'founding'
) AS n
WHERE m."wawuUserId" = n."wawuUserId";

-- CreateIndex
CREATE UNIQUE INDEX "MakerTier_badgeNumber_key" ON "MakerTier"("badgeNumber");

-- The counter starts after the highest number given.
INSERT INTO "BadgeNumberCounter" ("name", "last")
SELECT 'numbered_badge', COALESCE(MAX("badgeNumber"), 0) FROM "MakerTier";

ALTER TABLE "MakerTier" ADD CONSTRAINT "MakerTier_badgeNumber_check" CHECK ("badgeNumber" IS NULL OR "badgeNumber" >= 1);
