-- Professional profiles: creators listed as professionals in a category,
-- contacted through the existing paid-DM flow.
--
-- ADDITIVE ONLY. One new enum, one new table, its indexes and constraint.
-- No ALTER on any existing table, which matters because of hazard H-1: most
-- wire types in src/common/types are bare re-exports of their Prisma model
-- returned by spread, so a new column on an EXISTING table appears verbatim
-- in the shipped app's responses. A new table cannot do that.
--
-- NO MONEY HERE. There is no price, fee, escrow, invoice or payout column
-- below, and that is deliberate: contact is a paid DM (DirectMessage, which
-- already has its charge, its reply window and its refund path), and the
-- engagement itself is arranged off-platform. This table is a directory.

CREATE TYPE "ProfessionalCredentialKind" AS ENUM ('licence', 'qualification', 'portfolio');

CREATE TABLE "ProfessionalProfile" (
  "id"              TEXT NOT NULL,
  "wawuUserId"      TEXT NOT NULL,
  "category"        TEXT NOT NULL,
  "headline"        TEXT NOT NULL,
  "about"           TEXT NOT NULL,
  "services"        TEXT[] DEFAULT ARRAY[]::TEXT[],
  "credentialKind"  "ProfessionalCredentialKind" NOT NULL,
  "licenceNumber"   TEXT,
  "issuingBody"     TEXT,
  "documents"       TEXT[] DEFAULT ARRAY[]::TEXT[],
  "status"          "ReviewStatus" NOT NULL DEFAULT 'pending',
  "rejectionReason" TEXT,
  "submittedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedAt"      TIMESTAMP(3),
  "listed"          BOOLEAN NOT NULL DEFAULT true,

  CONSTRAINT "ProfessionalProfile_pkey" PRIMARY KEY ("id")
);

-- One application per person per category: a rejected one is edited and
-- resubmitted in place rather than piling up duplicates in a human's queue.
CREATE UNIQUE INDEX "ProfessionalProfile_wawuUserId_category_key"
  ON "ProfessionalProfile" ("wawuUserId", "category");

-- The directory read: approved professionals in one category.
CREATE INDEX "ProfessionalProfile_category_status_idx"
  ON "ProfessionalProfile" ("category", "status");

-- The review queue read.
CREATE INDEX "ProfessionalProfile_status_idx"
  ON "ProfessionalProfile" ("status");
