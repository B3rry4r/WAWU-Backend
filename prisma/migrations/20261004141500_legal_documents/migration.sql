-- SETTINGS-02: the owner's Terms and Privacy policy text. Additive: one new
-- table, no existing column, index or row touched (protected route registry,
-- H-1). Rollback: DROP TABLE "LegalDocument";

-- CreateTable
CREATE TABLE "LegalDocument" (
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "effectiveDate" DATE NOT NULL,
    "sections" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LegalDocument_pkey" PRIMARY KEY ("slug")
);
