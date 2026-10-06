-- Schools (task SCHOOLS-01): schools, their courses and each course's dated
-- intakes with a seat limit.
--
-- Additive only: two new enum types and three new tables. No existing table,
-- column, index or row is touched. (`prisma migrate diff` against a database
-- built from every earlier migration also proposes dropping
-- "ContentPiece_specializations_idx", the GIN index that
-- 20260921090000_content_specializations adds in raw SQL and the schema
-- cannot express; that line is not part of this migration.)
--
-- The CHECK constraints at the end are the database's own floor under the
-- seat count: SCHOOLS-07 claims a seat with a conditional write
-- (seatsTaken < capacity), and a row that would oversell or go negative is
-- refused here as well. Prisma does not model CHECK constraints, so they do
-- not show as drift.
--
-- Rollback: DROP TABLE "CourseIntake"; DROP TABLE "SchoolCourse"; DROP TABLE "School";
--           DROP TYPE "SchoolCourseMode"; DROP TYPE "SchoolCategory";

-- CreateEnum
CREATE TYPE "SchoolCategory" AS ENUM ('tech', 'business', 'creative', 'languages', 'vocational');

-- CreateEnum
CREATE TYPE "SchoolCourseMode" AS ENUM ('online', 'in_person', 'hybrid');

-- CreateTable
CREATE TABLE "School" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "SchoolCategory" NOT NULL,
    "location" TEXT NOT NULL,
    "foundedYear" INTEGER,
    "expertise" TEXT[],
    "about" TEXT NOT NULL,
    "logo" TEXT,
    "applyUrl" TEXT,
    "reportEmail" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "School_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SchoolCourse" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "weeks" INTEGER NOT NULL,
    "mode" "SchoolCourseMode" NOT NULL,
    "syllabus" TEXT[],
    "outcomes" TEXT[],
    "priceKobo" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SchoolCourse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CourseIntake" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "schedule" TEXT NOT NULL,
    "location" TEXT,
    "capacity" INTEGER NOT NULL,
    "seatsTaken" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CourseIntake_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "School_category_idx" ON "School"("category");

-- CreateIndex
CREATE INDEX "School_name_idx" ON "School"("name");

-- CreateIndex
CREATE INDEX "SchoolCourse_schoolId_idx" ON "SchoolCourse"("schoolId");

-- CreateIndex
CREATE INDEX "CourseIntake_courseId_startDate_idx" ON "CourseIntake"("courseId", "startDate");

-- AddForeignKey
ALTER TABLE "SchoolCourse" ADD CONSTRAINT "SchoolCourse_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseIntake" ADD CONSTRAINT "CourseIntake_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "SchoolCourse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seat limit and sane numbers
ALTER TABLE "CourseIntake" ADD CONSTRAINT "CourseIntake_capacity_check" CHECK ("capacity" >= 0);
ALTER TABLE "CourseIntake" ADD CONSTRAINT "CourseIntake_seatsTaken_check" CHECK ("seatsTaken" >= 0 AND "seatsTaken" <= "capacity");
ALTER TABLE "SchoolCourse" ADD CONSTRAINT "SchoolCourse_weeks_check" CHECK ("weeks" > 0);
ALTER TABLE "SchoolCourse" ADD CONSTRAINT "SchoolCourse_priceKobo_check" CHECK ("priceKobo" >= 0);
