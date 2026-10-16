-- SCHOOLS-02: hide a school, a course or an intake from the app without
-- deleting it. Additive: three new nullable columns. Null is shown; a time is
-- when the dashboard hid it.
ALTER TABLE "School" ADD COLUMN "hiddenAt" TIMESTAMP(3);
ALTER TABLE "SchoolCourse" ADD COLUMN "hiddenAt" TIMESTAMP(3);
ALTER TABLE "CourseIntake" ADD COLUMN "hiddenAt" TIMESTAMP(3);

-- Rollback: ALTER TABLE "School" DROP COLUMN "hiddenAt"; ALTER TABLE "SchoolCourse" DROP COLUMN "hiddenAt"; ALTER TABLE "CourseIntake" DROP COLUMN "hiddenAt";
