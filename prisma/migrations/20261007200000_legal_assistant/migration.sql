-- LEGAL-01: legal starts as a chat. Additive: three nullable columns on
-- "LegalIntake", one new enum, two new tables and one partial unique index
-- (on assistant rows only, so no intake written before this is affected). No
-- existing column, index or row is touched, so every intake written before
-- this reads exactly as it did.
-- Rollback: DROP INDEX "LegalIntake_one_open_assistant_key";
-- DROP TABLE "LegalAssistantCall"; DROP TABLE "LegalIntakeMessage";
-- DROP TYPE "LegalIntakeAuthor"; ALTER TABLE "LegalIntake" DROP COLUMN
-- "channel", DROP COLUMN "draftBrief", DROP COLUMN "assistantBusyUntil";

-- AlterTable
ALTER TABLE "LegalIntake" ADD COLUMN     "assistantBusyUntil" TIMESTAMP(3),
ADD COLUMN     "channel" TEXT,
ADD COLUMN     "draftBrief" JSONB;

-- CreateEnum
CREATE TYPE "LegalIntakeAuthor" AS ENUM ('client', 'assistant');

-- CreateTable
CREATE TABLE "LegalIntakeMessage" (
    "id" TEXT NOT NULL,
    "legalIntakeId" TEXT NOT NULL,
    "wawuUserId" TEXT NOT NULL,
    "authorRole" "LegalIntakeAuthor" NOT NULL,
    "scripted" BOOLEAN NOT NULL DEFAULT false,
    "body" TEXT NOT NULL,
    "quickReplies" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LegalIntakeMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LegalIntakeMessage_legalIntakeId_createdAt_idx" ON "LegalIntakeMessage"("legalIntakeId", "createdAt");

-- CreateIndex
CREATE INDEX "LegalIntakeMessage_wawuUserId_createdAt_idx" ON "LegalIntakeMessage"("wawuUserId", "createdAt");

-- CreateTable
CREATE TABLE "LegalAssistantCall" (
    "id" TEXT NOT NULL,
    "legalIntakeId" TEXT NOT NULL,
    "wawuUserId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LegalAssistantCall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LegalAssistantCall_legalIntakeId_createdAt_idx" ON "LegalAssistantCall"("legalIntakeId", "createdAt");

-- CreateIndex
CREATE INDEX "LegalAssistantCall_wawuUserId_createdAt_idx" ON "LegalAssistantCall"("wawuUserId", "createdAt");

-- One open assistant conversation per person. Written by hand: Prisma cannot
-- express a partial index, so the schema only notes it (model LegalIntake).
-- Intakes of the question form have a null channel and are outside it.
CREATE UNIQUE INDEX "LegalIntake_one_open_assistant_key" ON "LegalIntake"("wawuUserId") WHERE "channel" = 'assistant' AND "status" = 'in_progress';
