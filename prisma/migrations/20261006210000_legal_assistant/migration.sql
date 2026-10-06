-- LEGAL-01: legal starts as a chat. Additive: two nullable columns on
-- "LegalIntake", one new enum and one new table. No existing column, index or
-- row is touched, so every intake written before this reads exactly as it did.
-- Rollback: DROP TABLE "LegalIntakeMessage"; DROP TYPE "LegalIntakeAuthor";
-- ALTER TABLE "LegalIntake" DROP COLUMN "channel", DROP COLUMN "draftBrief";

-- AlterTable
ALTER TABLE "LegalIntake" ADD COLUMN     "channel" TEXT,
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
