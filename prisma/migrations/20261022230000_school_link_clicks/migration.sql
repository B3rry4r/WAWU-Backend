-- SCHOOLS-10: the code on a school's apply link and the log of taps on it.
-- Additive: two new tables, nothing else touched.
-- Rollback: DROP TABLE "SchoolLinkClick"; DROP TABLE "SchoolLink";

-- CreateTable
CREATE TABLE "SchoolLink" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SchoolLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SchoolLinkClick" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "courseId" TEXT,
    "userWawuId" TEXT NOT NULL,
    "clickedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SchoolLinkClick_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SchoolLink_schoolId_key" ON "SchoolLink"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "SchoolLink_code_key" ON "SchoolLink"("code");

-- CreateIndex
CREATE INDEX "SchoolLinkClick_schoolId_clickedAt_idx" ON "SchoolLinkClick"("schoolId", "clickedAt");

-- CreateIndex
CREATE INDEX "SchoolLinkClick_courseId_idx" ON "SchoolLinkClick"("courseId");

-- CreateIndex
CREATE INDEX "SchoolLinkClick_userWawuId_clickedAt_idx" ON "SchoolLinkClick"("userWawuId", "clickedAt");

-- AddForeignKey
ALTER TABLE "SchoolLink" ADD CONSTRAINT "SchoolLink_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolLinkClick" ADD CONSTRAINT "SchoolLinkClick_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolLinkClick" ADD CONSTRAINT "SchoolLinkClick_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "SchoolCourse"("id") ON DELETE SET NULL ON UPDATE CASCADE;
