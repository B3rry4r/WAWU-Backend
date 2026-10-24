\set ON_ERROR_STOP on
-- Rollback of 20261105093000_content_parent_course (FIX-111). Run it only after the Hub build that reads this is gone.
-- Run with: psql -1 -f rollback.sql
-- Refuses (and changes nothing) while any piece names a parent course: dropping the column loses which course a piece comes
-- from. Clear them on purpose first:
--   UPDATE "ContentDetail" SET "parentCourseId" = NULL;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "ContentDetail" WHERE "parentCourseId" IS NOT NULL) THEN
    RAISE EXCEPTION 'FIX-111 rollback: pieces name a parent course and would lose it. Nothing was changed.';
  END IF;
END $$;
ALTER TABLE "ContentDetail" DROP CONSTRAINT "ContentDetail_parentCourseId_fkey";
DROP INDEX "ContentDetail_parentCourseId_idx";
ALTER TABLE "ContentDetail" DROP COLUMN "parentCourseId";
