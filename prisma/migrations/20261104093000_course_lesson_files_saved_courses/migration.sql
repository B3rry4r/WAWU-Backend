-- FIX-107. A course lesson has its own file (H25: play lesson by lesson, the first free), and a school course can be saved
-- (SC3's bookmark, G-627). Additive only: one nullable column and one new table. Nothing the web or the dashboard calls
-- reads or writes either; a lesson row without a file is what every row is today.

ALTER TABLE "CourseLesson" ADD COLUMN "assetKey" TEXT;

CREATE TABLE "SavedSchoolCourse" (
    "id" TEXT NOT NULL,
    "userWawuId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "savedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SavedSchoolCourse_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SavedSchoolCourse_userWawuId_courseId_key" ON "SavedSchoolCourse"("userWawuId", "courseId");
CREATE INDEX "SavedSchoolCourse_userWawuId_savedAt_idx" ON "SavedSchoolCourse"("userWawuId", "savedAt");
CREATE INDEX "SavedSchoolCourse_courseId_idx" ON "SavedSchoolCourse"("courseId");

ALTER TABLE "SavedSchoolCourse" ADD CONSTRAINT "SavedSchoolCourse_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "SchoolCourse"("id") ON DELETE CASCADE ON UPDATE CASCADE;
