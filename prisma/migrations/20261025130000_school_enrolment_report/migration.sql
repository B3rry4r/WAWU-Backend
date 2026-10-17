-- SCHOOLS-09: the enrolment report that goes to the school.
--
-- Additive only: one new table. No existing table, column or index changes.
--
-- SchoolEnrolmentReport: one row per school enrolment order, made in the same
-- transaction as the order. It holds the time the student agreed to share
-- their details with the school (`consentAt`, SC4's Continue), a copy of the
-- student's name, email and phone for as long as the report has not gone
-- (the send clears them), and the delivery state: the mail relay's id, the
-- tries, the rest before the next try and when the tries ran out.
--
-- Rollback: DROP TABLE "SchoolEnrolmentReport". Nothing else refers to it.

-- CreateTable
CREATE TABLE "SchoolEnrolmentReport" (
    "enrolmentId" TEXT NOT NULL,
    "wawuUserId" TEXT,
    "studentName" TEXT,
    "studentEmail" TEXT,
    "studentPhone" TEXT,
    "consentAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "leaseUntil" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "messageId" TEXT,
    "lastError" TEXT,
    "gaveUpAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SchoolEnrolmentReport_pkey" PRIMARY KEY ("enrolmentId"),
    CONSTRAINT "SchoolEnrolmentReport_attempts_check" CHECK ("attempts" >= 0)
);

-- CreateIndex
CREATE INDEX "SchoolEnrolmentReport_sentAt_gaveUpAt_nextAttemptAt_idx" ON "SchoolEnrolmentReport"("sentAt", "gaveUpAt", "nextAttemptAt");

-- AddForeignKey
ALTER TABLE "SchoolEnrolmentReport" ADD CONSTRAINT "SchoolEnrolmentReport_enrolmentId_fkey" FOREIGN KEY ("enrolmentId") REFERENCES "SchoolEnrolment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
