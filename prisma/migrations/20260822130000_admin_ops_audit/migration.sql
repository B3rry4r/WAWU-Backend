-- Attribution for the six operator controllers that moved off AdminKeyGuard
-- (a single shared static secret with no identity) onto AdminAuthGuard +
-- AdminRolesGuard.
--
-- ADDITIVE ONLY. Two new enum types, one new table, three new indexes. There
-- is deliberately no ALTER TABLE below: nothing in
-- .pipeline/protected-registry.json's schema map is dropped, renamed,
-- retyped, narrowed or widened.
--
-- Why a side table rather than actedByAdminId columns on "LegalRequest",
-- "ServiceApplication", "BillPayment" and "HealthSubscription": protected-
-- surface hazard H-1. Those four are bare Prisma re-exports returned by
-- spread, so a new column on any of them would appear in the SHIPPED app's
-- responses — a client would be shown which member of WAWU staff priced or
-- cancelled their matter — without a line of application code changing.
--
-- The two content surfaces in the same change (Playbook, LearnGuide) are NOT
-- audited here. Both already carry an `updatedBy` column that has never had a
-- writer, so their attribution needs no schema change at all.
--
-- No foreign keys, matching every other cross-boundary reference in this
-- schema (KycSubmission.wawuUserId, Purchase.buyerWawuId): an audit row has to
-- outlive the record it audits.

-- CreateEnum
CREATE TYPE "AdminOpsResource" AS ENUM ('legal_request', 'service_application', 'bill_payment', 'health_subscription');

-- CreateEnum
CREATE TYPE "AdminOpsAction" AS ENUM ('legal_quoted', 'legal_consultation_completed', 'legal_delivered', 'legal_cancelled', 'application_progressed', 'application_rejected', 'application_approved', 'bill_reconciled', 'bill_refund_recorded', 'care_enrolment_retried', 'care_refund_recorded');

-- CreateTable
CREATE TABLE "AdminOpsAudit" (
    "id" TEXT NOT NULL,
    "resource" "AdminOpsResource" NOT NULL,
    "resourceId" TEXT NOT NULL,
    "subjectWawuId" TEXT NOT NULL,
    "action" "AdminOpsAction" NOT NULL,
    "detail" JSONB,
    "actedByAdminId" TEXT NOT NULL,
    "actedByAdminEmail" TEXT NOT NULL,
    "actedByAdminRole" "AdminRole" NOT NULL,
    "actedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminOpsAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdminOpsAudit_resource_resourceId_idx" ON "AdminOpsAudit"("resource", "resourceId");

-- CreateIndex
CREATE INDEX "AdminOpsAudit_actedByAdminId_idx" ON "AdminOpsAudit"("actedByAdminId");

-- CreateIndex
CREATE INDEX "AdminOpsAudit_actedAt_idx" ON "AdminOpsAudit"("actedAt");
