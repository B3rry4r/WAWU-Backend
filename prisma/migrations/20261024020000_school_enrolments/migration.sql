-- Enrol in a course and pay from the wallet (task SCHOOLS-07).
--
-- Additive only: one new table. No existing column, index or row changes
-- meaning. The Learn tables (LearnCourse, CourseEnrollment) are not touched:
-- a school enrolment never reads them.
--
-- SchoolEnrolment: one row per student and intake, the order a `school_fee`
-- wallet payment pays for. "status" is reserved, enrolled, released or
-- refunded. The seat is claimed in CourseIntake.seatsTaken by a conditional
-- write (seatsTaken < capacity), which CourseIntake's own CHECK also backs.
--
-- The partial unique index allows one live order (reserved or enrolled) per
-- student and course, so the same enrol request twice is one order and one seat.
-- The CHECKs keep the money figures whole and the split at the ruled 85/15.
--
-- Rollback: DROP TABLE "SchoolEnrolment";

-- CreateTable
CREATE TABLE "SchoolEnrolment" (
    "id" TEXT NOT NULL,
    "wawuUserId" TEXT,
    "schoolId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "intakeId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'reserved',
    "reference" TEXT NOT NULL,
    "courseTitle" TEXT NOT NULL,
    "schoolName" TEXT NOT NULL,
    "intakeStartDate" DATE NOT NULL,
    "intakeSchedule" TEXT NOT NULL,
    "intakeLocation" TEXT,
    "priceKobo" INTEGER NOT NULL,
    "schoolShareKobo" INTEGER NOT NULL,
    "wawuShareKobo" INTEGER NOT NULL,
    "commissionBps" INTEGER NOT NULL,
    "reservedUntil" TIMESTAMP(3) NOT NULL,
    "paymentId" TEXT,
    "holdId" TEXT,
    "enrolledAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SchoolEnrolment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SchoolEnrolment_reference_key" ON "SchoolEnrolment"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "SchoolEnrolment_paymentId_key" ON "SchoolEnrolment"("paymentId");

-- CreateIndex
CREATE INDEX "SchoolEnrolment_wawuUserId_createdAt_idx" ON "SchoolEnrolment"("wawuUserId", "createdAt");

-- CreateIndex
CREATE INDEX "SchoolEnrolment_intakeId_status_idx" ON "SchoolEnrolment"("intakeId", "status");

-- CreateIndex
CREATE INDEX "SchoolEnrolment_status_reservedUntil_idx" ON "SchoolEnrolment"("status", "reservedUntil");

-- AddForeignKey
ALTER TABLE "SchoolEnrolment" ADD CONSTRAINT "SchoolEnrolment_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolEnrolment" ADD CONSTRAINT "SchoolEnrolment_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "SchoolCourse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolEnrolment" ADD CONSTRAINT "SchoolEnrolment_intakeId_fkey" FOREIGN KEY ("intakeId") REFERENCES "CourseIntake"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- One live order per student and course (nulls are not equal, so a deleted
-- account's rows never clash).
CREATE UNIQUE INDEX "SchoolEnrolment_one_live_per_course_key" ON "SchoolEnrolment"("wawuUserId", "courseId") WHERE "status" IN ('reserved', 'enrolled');

ALTER TABLE "SchoolEnrolment" ADD CONSTRAINT "SchoolEnrolment_status_check" CHECK ("status" IN ('reserved', 'enrolled', 'released', 'refunded'));
ALTER TABLE "SchoolEnrolment" ADD CONSTRAINT "SchoolEnrolment_figures_check" CHECK ("priceKobo" >= 0 AND "schoolShareKobo" >= 0 AND "wawuShareKobo" >= 0 AND "schoolShareKobo" + "wawuShareKobo" = "priceKobo");
