-- AITOOLS-01: one table for the runs of the AI tools (VoiceOver first) and one
-- enum for where a run is. Additive only: nothing existing is touched.
--
-- "AiToolJob" holds no text a person typed. The points a run costs are held in
-- "PointHold" (POINTS-03, purpose ai_job, reference "<id>:1"); this row only
-- records the run. ("wawuUserId", "idempotencyKey") is unique, so a retry of a
-- request whose answer was lost finds the first run instead of starting one.
-- The CHECKs hold the vocabulary and the sizes.
--
-- Rollback (nothing else references the table): DROP TABLE "AiToolJob";
-- DROP TYPE "AiJobState";

-- CreateEnum
CREATE TYPE "AiJobState" AS ENUM ('working', 'done', 'failed');

-- CreateTable
CREATE TABLE "AiToolJob" (
    "id" TEXT NOT NULL,
    "wawuUserId" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "voiceId" TEXT NOT NULL,
    "characters" INTEGER NOT NULL,
    "units" INTEGER NOT NULL,
    "costPoints" INTEGER NOT NULL,
    "state" "AiJobState" NOT NULL DEFAULT 'working',
    "holdId" TEXT,
    "failureCode" TEXT,
    "audioKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "AiToolJob_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AiToolJob_sizes_check" CHECK ("characters" >= 0 AND "units" >= 1 AND "costPoints" >= 1),
    CONSTRAINT "AiToolJob_failure_check" CHECK (("state" = 'failed') = ("failureCode" IS NOT NULL)),
    CONSTRAINT "AiToolJob_audio_check" CHECK ("audioKey" IS NULL OR "state" = 'done')
);

-- CreateIndex
CREATE UNIQUE INDEX "AiToolJob_wawuUserId_idempotencyKey_key" ON "AiToolJob"("wawuUserId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "AiToolJob_wawuUserId_createdAt_idx" ON "AiToolJob"("wawuUserId", "createdAt");

-- CreateIndex
CREATE INDEX "AiToolJob_state_createdAt_idx" ON "AiToolJob"("state", "createdAt");
