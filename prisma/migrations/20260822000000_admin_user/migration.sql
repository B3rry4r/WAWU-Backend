-- Admin identity — admin-surface-extension Phase 5.
--
-- ADDITIVE ONLY. Two new enum types, one new table, three new indexes.
-- Nothing existing is dropped, renamed, retyped, narrowed or widened; no
-- ALTER TABLE against any table in .pipeline/protected-registry.json's
-- schema map appears below, deliberately.
--
-- Why a separate table rather than a flag on an existing row: user identity
-- for this backend lives in WAWU ID (SSO) and there is no local User table
-- to flag. Beyond that, protected-surface hazard H-1 says every wire type in
-- src/common/types is a bare re-export of its Prisma model returned by
-- spread — so a new column on an existing entity would silently appear in
-- that entity's SHIPPED app response. A new table cannot do that.

-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('superadmin', 'reviewer', 'support', 'finance');

-- CreateEnum
CREATE TYPE "AdminUserStatus" AS ENUM ('active', 'suspended');

-- CreateTable
CREATE TABLE "AdminUser" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "AdminRole" NOT NULL,
    "status" "AdminUserStatus" NOT NULL DEFAULT 'active',
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminUser_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdminUser_email_key" ON "AdminUser"("email");

-- CreateIndex
CREATE INDEX "AdminUser_role_idx" ON "AdminUser"("role");

-- CreateIndex
CREATE INDEX "AdminUser_status_idx" ON "AdminUser"("status");
