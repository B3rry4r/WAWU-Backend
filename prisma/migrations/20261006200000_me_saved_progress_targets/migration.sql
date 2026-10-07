-- ME-10: saved creators, course lesson progress, notification targets.
-- Additive only: three new tables, nothing existing is altered. The relation
-- fields added to CourseLesson and Notification in schema.prisma are virtual
-- (no column), so no existing response gains a key.
--
-- Rollback (replayed on a scratch database, the schema then equals main's):
--   DROP TABLE "NotificationTarget";
--   DROP TABLE "CourseLessonProgress";
--   DROP TABLE "SavedCreator";

-- CreateTable
CREATE TABLE "CourseLessonProgress" (
    "id" TEXT NOT NULL,
    "userWawuId" TEXT NOT NULL,
    "lessonId" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "doneAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CourseLessonProgress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationTarget" (
    "notificationId" TEXT NOT NULL,
    "targetKind" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "actorWawuId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationTarget_pkey" PRIMARY KEY ("notificationId")
);

-- CreateTable
CREATE TABLE "SavedCreator" (
    "id" TEXT NOT NULL,
    "userWawuId" TEXT NOT NULL,
    "creatorWawuId" TEXT NOT NULL,
    "savedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SavedCreator_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CourseLessonProgress_userWawuId_contentId_idx" ON "CourseLessonProgress"("userWawuId", "contentId");

-- CreateIndex
CREATE INDEX "CourseLessonProgress_lessonId_idx" ON "CourseLessonProgress"("lessonId");

-- CreateIndex
CREATE UNIQUE INDEX "CourseLessonProgress_userWawuId_lessonId_key" ON "CourseLessonProgress"("userWawuId", "lessonId");

-- CreateIndex
CREATE INDEX "NotificationTarget_actorWawuId_idx" ON "NotificationTarget"("actorWawuId");

-- CreateIndex
CREATE INDEX "SavedCreator_userWawuId_savedAt_idx" ON "SavedCreator"("userWawuId", "savedAt");

-- CreateIndex
CREATE INDEX "SavedCreator_creatorWawuId_idx" ON "SavedCreator"("creatorWawuId");

-- CreateIndex
CREATE UNIQUE INDEX "SavedCreator_userWawuId_creatorWawuId_key" ON "SavedCreator"("userWawuId", "creatorWawuId");

-- AddForeignKey
ALTER TABLE "CourseLessonProgress" ADD CONSTRAINT "CourseLessonProgress_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "CourseLesson"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationTarget" ADD CONSTRAINT "NotificationTarget_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

