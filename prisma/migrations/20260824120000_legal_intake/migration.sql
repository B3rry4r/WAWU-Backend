-- Legal intake: profiling before anybody talks about money.
--
-- ADDITIVE ONLY. One enum, one new table. No ALTER on any existing table,
-- which matters because of hazard H-1: most wire types in src/common/types
-- are bare re-exports of their Prisma model returned by spread, so a new
-- column on an existing table appears verbatim in the shipped app's
-- responses. A new table cannot do that.

CREATE TYPE "LegalIntakeStatus" AS ENUM ('in_progress', 'completed', 'converted');

CREATE TABLE "LegalIntake" (
  "id"             TEXT NOT NULL,
  "wawuUserId"     TEXT NOT NULL,
  "matter"         TEXT NOT NULL,
  "status"         "LegalIntakeStatus" NOT NULL DEFAULT 'in_progress',
  "answers"        JSONB NOT NULL DEFAULT '{}',
  "documents"      TEXT[] DEFAULT ARRAY[]::TEXT[],
  "brief"          JSONB,
  "legalRequestId" TEXT,
  "startedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt"    TIMESTAMP(3),

  CONSTRAINT "LegalIntake_pkey" PRIMARY KEY ("id")
);

-- One intake per request, once converted.
CREATE UNIQUE INDEX "LegalIntake_legalRequestId_key"
  ON "LegalIntake" ("legalRequestId");

-- "Do I have an intake in progress?" — the read every screen makes.
CREATE INDEX "LegalIntake_wawuUserId_status_idx"
  ON "LegalIntake" ("wawuUserId", "status");

-- The consultant's queue: completed intakes, oldest first.
CREATE INDEX "LegalIntake_status_completedAt_idx"
  ON "LegalIntake" ("status", "completedAt");
