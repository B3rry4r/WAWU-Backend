-- Featured works and education (task ME-16): what a creator's profile shows
-- under "Featured works" (M33, M34, M35) and "Education" (M33).
--
-- Additive only: two new tables. No existing table, column, index or row is
-- touched ("UserProfile" is not altered, so GET and PATCH /users/me and the
-- public profile answer exactly as before). An account that never adds one
-- has no row. The CHECKs are outer bounds that hold whatever the app says;
-- the app's own, tighter ranges move with the calendar and live in code.
-- (`prisma migrate diff` against a database built from every earlier
-- migration also proposes dropping "ContentPiece_specializations_idx", the
-- GIN index that 20260921090000_content_specializations adds in raw SQL and
-- the schema cannot express; that line is not part of this migration.)
--
-- Rollback (also deletes the migration's own record, or `prisma migrate
-- deploy` would believe it is still applied):
--   DROP TABLE "ProfileWork";
--   DROP TABLE "ProfileEducation";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261004200000_profile_works_education';

-- CreateTable
CREATE TABLE "ProfileWork" (
    "id" TEXT NOT NULL,
    "wawuUserId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "client" TEXT,
    "year" INTEGER NOT NULL,
    "link" TEXT,
    "category" TEXT,
    "description" TEXT,
    "media" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProfileWork_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProfileWork_year_range" CHECK ("year" BETWEEN 1900 AND 2100)
);

-- CreateTable
CREATE TABLE "ProfileEducation" (
    "id" TEXT NOT NULL,
    "wawuUserId" TEXT NOT NULL,
    "school" TEXT NOT NULL,
    "field" TEXT,
    "startYear" INTEGER NOT NULL,
    "endYear" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProfileEducation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProfileEducation_years" CHECK (
      "startYear" BETWEEN 1900 AND 2100
      AND ("endYear" IS NULL OR ("endYear" BETWEEN 1900 AND 2100 AND "endYear" >= "startYear"))
    )
);

-- CreateIndex
CREATE INDEX "ProfileWork_wawuUserId_position_idx" ON "ProfileWork"("wawuUserId", "position");

-- CreateIndex
CREATE INDEX "ProfileEducation_wawuUserId_startYear_idx" ON "ProfileEducation"("wawuUserId", "startYear");
