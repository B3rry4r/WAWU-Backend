-- Profile details (task ME-05): the location, skills, "open to" chips, Threads
-- handle and social-link order the profile screens show.
--
-- Additive only: one new table. No existing table, column, index or row is
-- touched ("UserProfile" is not altered, so GET and PATCH /users/me answer
-- exactly as before). An account that never sets one of these has no row.
-- (`prisma migrate diff` against a database built from every earlier
-- migration also proposes dropping "ContentPiece_specializations_idx", the
-- GIN index that 20260921090000_content_specializations adds in raw SQL and
-- the schema cannot express; that line is not part of this migration.)
--
-- Rollback (also deletes the migration's own record, or `prisma migrate
-- deploy` would believe it is still applied):
--   DROP TABLE "ProfileDetails";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261003200000_profile_details';

-- CreateTable
CREATE TABLE "ProfileDetails" (
    "wawuUserId" TEXT NOT NULL,
    "location" TEXT,
    "skills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "openTo" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "threadsHandle" TEXT,
    "socialOrder" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProfileDetails_pkey" PRIMARY KEY ("wawuUserId")
);
