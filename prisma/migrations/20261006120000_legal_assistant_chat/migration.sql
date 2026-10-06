-- LEGAL-01: the legal chat starts before anyone pays. Additive only: one new
-- table, two new nullable columns on "LegalIntake". No existing column, index
-- or row is touched, so the question form the web calls behaves as before.
-- Rollback:
--   DROP TABLE "LegalIntakeMessage";
--   ALTER TABLE "LegalIntake" DROP COLUMN "assistantReadyAt", DROP COLUMN "channel";

-- AlterTable
ALTER TABLE "LegalIntake" ADD COLUMN     "assistantReadyAt" TIMESTAMP(3),
ADD COLUMN     "channel" TEXT;

-- CreateTable
CREATE TABLE "LegalIntakeMessage" (
    "id" TEXT NOT NULL,
    "legalIntakeId" TEXT NOT NULL,
    "wawuUserId" TEXT NOT NULL,
    "authorRole" "LegalChatAuthor" NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LegalIntakeMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LegalIntakeMessage_legalIntakeId_createdAt_idx" ON "LegalIntakeMessage"("legalIntakeId", "createdAt");

-- CreateIndex
CREATE INDEX "LegalIntakeMessage_wawuUserId_idx" ON "LegalIntakeMessage"("wawuUserId");

-- AddForeignKey
ALTER TABLE "LegalIntakeMessage" ADD CONSTRAINT "LegalIntakeMessage_legalIntakeId_fkey" FOREIGN KEY ("legalIntakeId") REFERENCES "LegalIntake"("id") ON DELETE CASCADE ON UPDATE CASCADE;
