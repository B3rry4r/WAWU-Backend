-- FIX-06: an admin's unlist of a professional listing, kept apart from the
-- person's own Hide.
--
-- Additive only: one new table. No existing table, column, index or row is
-- touched, so no answer a live route gives for an existing listing changes.
-- Rollback: DROP TABLE "ProfessionalTakedown";
--
-- Backfill: none, by design, and this is the reason. Until this migration
-- POST /admin/professionals/:id/unlist wrote `listed = false` on the
-- listing and nothing else, and no audit table covers professional listings
-- (AdminOpsResource has no professional value; AdminContentReview,
-- AdminKycAudit, AdminVerificationAudit, AdminEventReview, AdminAdAudit and
-- AdminNotificationAudit audit other things). So no admin audit row can say
-- that an existing `listed = false` row was an admin's unlist, and every
-- such row keeps the meaning it has today: the person's own Hide (or, on a
-- rejected application, the rejection). With no row in this table the
-- person's Show works on them exactly as before. A listing an admin pulled
-- before this deploy is made to hold by unlisting it once more.

-- CreateTable
CREATE TABLE "ProfessionalTakedown" (
    "professionalId" TEXT NOT NULL,
    "wawuUserId" TEXT NOT NULL,
    "ownerListed" BOOLEAN NOT NULL,
    "takenDownAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "takenDownByAdminId" TEXT NOT NULL,
    "takenDownByAdminEmail" TEXT NOT NULL,
    "takenDownByAdminRole" "AdminRole" NOT NULL,
    "liftedAt" TIMESTAMP(3),
    "liftedByAdminId" TEXT,
    "liftedByAdminEmail" TEXT,
    "liftedByAdminRole" "AdminRole",

    CONSTRAINT "ProfessionalTakedown_pkey" PRIMARY KEY ("professionalId")
);

-- CreateIndex
CREATE INDEX "ProfessionalTakedown_wawuUserId_idx" ON "ProfessionalTakedown"("wawuUserId");
