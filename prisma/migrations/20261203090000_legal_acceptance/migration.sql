-- LEGAL-DOCS: what a person agreed to at sign-up. Additive: one new table, no existing column, index, constraint or row is
-- touched (protected route registry: nothing the web or the dashboard calls changes).
--
-- One row per person, document and version: "slug" is one of the owner's nine documents, "effectiveDate" is the date of the version
-- the Hub had published when the app wrote the record, "acceptedAt" is the time, "how" says where the person agreed ("signup").
-- The unique key makes a retried write a no-op and lets a republished document (a new effective date) add one more row.
-- The table starts empty: nobody who signed up before this migration has a record, and none is invented for them.
-- Rollback: see rollback.sql (refuses while any record exists).

-- CreateTable
CREATE TABLE "LegalAcceptance" (
    "id" TEXT NOT NULL,
    "userWawuId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "effectiveDate" DATE NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "how" TEXT NOT NULL,

    CONSTRAINT "LegalAcceptance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LegalAcceptance_userWawuId_idx" ON "LegalAcceptance"("userWawuId");

-- CreateIndex
CREATE UNIQUE INDEX "LegalAcceptance_userWawuId_slug_effectiveDate_key" ON "LegalAcceptance"("userWawuId", "slug", "effectiveDate");
