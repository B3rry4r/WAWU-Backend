/*
  Warnings:

  - You are about to drop the column `publicSignupEnabled` on the `PlatformSettings` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "PlatformSettings" DROP COLUMN "publicSignupEnabled",
ADD COLUMN     "userSignupEnabled" BOOLEAN NOT NULL DEFAULT true;
