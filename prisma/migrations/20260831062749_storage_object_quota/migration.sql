-- CreateEnum
CREATE TYPE "StorageObjectStatus" AS ENUM ('pending', 'confirmed', 'abandoned');

-- CreateTable
CREATE TABLE "StorageObject" (
    "id" TEXT NOT NULL,
    "wawuUserId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "contentType" TEXT NOT NULL,
    "folder" TEXT NOT NULL,
    "status" "StorageObjectStatus" NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "StorageObject_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StorageObject_key_key" ON "StorageObject"("key");

-- CreateIndex
CREATE INDEX "StorageObject_wawuUserId_status_idx" ON "StorageObject"("wawuUserId", "status");

-- CreateIndex
CREATE INDEX "StorageObject_status_createdAt_idx" ON "StorageObject"("status", "createdAt");
