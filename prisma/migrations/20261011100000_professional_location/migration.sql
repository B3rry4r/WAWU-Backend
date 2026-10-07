-- PROS-02: the city on a professional's card and in the directory.
-- Additive only: one new table. No existing table, column, index or row is
-- touched, so no answer a live route gives changes.
-- Rollback: DROP TABLE "ProfessionalLocation";

-- CreateTable
CREATE TABLE "ProfessionalLocation" (
    "wawuUserId" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProfessionalLocation_pkey" PRIMARY KEY ("wawuUserId")
);
