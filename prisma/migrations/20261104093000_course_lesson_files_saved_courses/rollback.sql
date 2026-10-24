\set ON_ERROR_STOP on
-- Rollback of 20261104093000_course_lesson_files_saved_courses (FIX-107). Run it only after the Hub build that reads
-- these is gone. Run with: psql -1 -f rollback.sql
-- Refuses (and changes nothing) while any lesson holds a file or any course is saved: dropping the column loses which
-- file a lesson plays (the files stay in the bucket, unreachable), and dropping the table loses people's bookmarks.
-- Clear them on purpose first:
--   UPDATE "CourseLesson" SET "assetKey" = NULL;
--   DELETE FROM "SavedSchoolCourse";
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "CourseLesson" WHERE "assetKey" IS NOT NULL) THEN
    RAISE EXCEPTION 'FIX-107 rollback: course lessons hold files and would lose them. Nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM "SavedSchoolCourse") THEN
    RAISE EXCEPTION 'FIX-107 rollback: saved school courses are stored and would be lost. Nothing was changed.';
  END IF;
END $$;
DROP TABLE "SavedSchoolCourse";
ALTER TABLE "CourseLesson" DROP COLUMN "assetKey";
