-- USER-SUSPEND (R-121; store review: Apple guideline 1.2, Google Play's user-generated content policy). A moderator can
-- suspend a person who posted something that came down, and lift it again. Additive only: ONE new table and new
-- values in each of the two admin audit enums (the suspension's own, and the report queue's). Nothing the web, the dashboard or the live app calls reads the table;
-- a person with no row here is unchanged in every answer.
--
-- Why a table and not columns on "UserProfile": a profile row is not created for everyone the moment they sign up, and
-- a suspension needs a history (who suspended, why, who lifted, when). One row per suspension; "liftedAt" null means in
-- force. The partial unique index lets a person have one suspension in force at a time and any number in the past.
-- "reason" is one of the same fixed list the report sheet uses.
--
-- Rollback: rollback.sql in this folder. It refuses while any suspension is in force (lifting it first is a moderator's
-- act); a lifted suspension is history that the audit trail also holds, and goes with the table. The enum values cannot
-- be dropped in Postgres without recreating the types: they are unused when rolled back and are left in place, so the
-- ADD VALUE lines below say IF NOT EXISTS and this migration can be applied again after a rollback (up, down, up).

-- AlterEnum
ALTER TYPE "AdminOpsResource" ADD VALUE IF NOT EXISTS 'user_suspension';

-- AlterEnum
ALTER TYPE "AdminOpsAction" ADD VALUE IF NOT EXISTS 'user_suspended';
ALTER TYPE "AdminOpsAction" ADD VALUE IF NOT EXISTS 'user_suspension_lifted';

-- AlterEnum (round 2, L1: a report dismissed, and a comment or message a report took down, are in the audit trail too)
ALTER TYPE "AdminOpsResource" ADD VALUE IF NOT EXISTS 'ugc_report';
ALTER TYPE "AdminOpsAction" ADD VALUE IF NOT EXISTS 'ugc_report_dismissed';
ALTER TYPE "AdminOpsAction" ADD VALUE IF NOT EXISTS 'ugc_item_removed';

-- CreateTable
CREATE TABLE "UserSuspension" (
    "id" TEXT NOT NULL,
    "wawuUserId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "reportId" TEXT,
    "suspendedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "suspendedByAdminId" TEXT NOT NULL,
    "suspendedByAdminEmail" TEXT NOT NULL,
    "suspendedByAdminRole" "AdminRole" NOT NULL,
    "liftedAt" TIMESTAMP(3),
    "liftNote" TEXT,
    "liftedByAdminId" TEXT,
    "liftedByAdminEmail" TEXT,
    "liftedByAdminRole" "AdminRole",

    CONSTRAINT "UserSuspension_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "UserSuspension_reason_check" CHECK ("reason" IN ('spam', 'harassment', 'hate', 'sexual', 'illegal', 'impersonation', 'other')),
    CONSTRAINT "UserSuspension_note_check" CHECK ("note" IS NULL OR char_length("note") <= 1000),
    CONSTRAINT "UserSuspension_lift_check" CHECK (("liftedAt" IS NULL AND "liftedByAdminId" IS NULL) OR ("liftedAt" IS NOT NULL AND "liftedByAdminId" IS NOT NULL))
);

-- CreateIndex
CREATE INDEX "UserSuspension_wawuUserId_suspendedAt_idx" ON "UserSuspension"("wawuUserId", "suspendedAt");

-- CreateIndex
CREATE INDEX "UserSuspension_liftedAt_idx" ON "UserSuspension"("liftedAt");

-- One suspension in force per person.
CREATE UNIQUE INDEX "UserSuspension_in_force_key" ON "UserSuspension"("wawuUserId") WHERE "liftedAt" IS NULL;
