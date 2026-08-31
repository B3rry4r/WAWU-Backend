-- CreateTable
CREATE TABLE "DittoOptIn" (
    "wawuUserId" TEXT NOT NULL,
    "optedInAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "emailedAt" TIMESTAMP(3),

    CONSTRAINT "DittoOptIn_pkey" PRIMARY KEY ("wawuUserId")
);
