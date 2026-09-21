-- The two-tick verification model.
--
-- Replaces the five-rung ladder (basic -> verified_user -> verified_business ->
-- certified_professional -> trusted_partner) with two INDEPENDENT paid ticks:
-- creator (purple) and professional (green). A person may hold one, both or
-- neither, because a person may hold more than one role, and neither outranks
-- the other.
--
-- EXPAND ONLY. This migration adds columns and backfills them. It does NOT
-- drop "VerificationTier", "VerificationSubmission"."tier" or
-- "AdminVerificationAudit"."tier": an instance of the previous build is still
-- selecting those while this one rolls out, and dropping a column an older
-- running instance still reads is how a deploy takes production down. The
-- drop is a separate migration once nothing reads them.

-- ── 1. The four columns, on the Hub's own user row ─────────────────────────
--
-- Nullable, no default. NULL "...verified_at" means never verified; a
-- non-NULL "...verified_at" with a NULL "...verified_until" is a perpetual,
-- admin-granted tick. `verified` is never stored: it is derived from these
-- two dates in exactly one place, deriveVerificationState() in
-- src/common/verification/verification-state.ts.
--
-- WAWU ID stays the source of truth and is written first on every grant and
-- revoke. These columns are the Hub's mirror so that a page of creator cards
-- renders its ticks from one query instead of depending on identity being
-- reachable.
ALTER TABLE "UserProfile"
  ADD COLUMN IF NOT EXISTS "creator_verified_at"         TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "creator_verified_until"      TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "professional_verified_at"    TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "professional_verified_until" TIMESTAMP(3);

-- ── 2. Backfill from the old ladder, in this same migration ────────────────
--
--   basic, verified_user
--       -> no tick at all. Nothing to write.
--   verified_business, certified_professional, trusted_partner, official
--       -> the professional tick, granted now, "until" NULL.
--          NULL means perpetual: these accounts were vetted by hand and never
--          paid for an annual term, so expiring them on a date they were
--          never told about would strip a badge somebody earned.
--   nobody receives the CREATOR tick on backfill. A paid creator tick has
--   never existed before this migration, so there is no one to grandfather.
--
-- The Hub holds no tier column of its own, so the ladder value here is read
-- from the only local record of it: an APPROVED "VerificationSubmission".
-- (WAWU ID backfills the same accounts from its own "verification_tier"
-- column; these two agree because that column is what an approval here
-- wrote.) "official" is in the list because the shared contract names it,
-- even though this database's enum never had that value - listing it costs
-- nothing and stops the two repos disagreeing.
UPDATE "UserProfile" p
SET "professional_verified_at"    = NOW(),
    "professional_verified_until" = NULL
WHERE p."professional_verified_at" IS NULL
  AND EXISTS (
    SELECT 1
    FROM "VerificationSubmission" v
    WHERE v."wawuUserId" = p."wawuUserId"
      AND v."status" = 'approved'
      AND v."tier"::text IN (
        'verified_business',
        'certified_professional',
        'trusted_partner',
        'official'
      )
  );

-- ── 3. What the ticks cost ─────────────────────────────────────────────────
--
-- Columns, not constants: a price is a commercial decision that should not
-- need a deploy, and "PlatformSettings" already exists to be changed from the
-- dashboard. Naira, whole numbers. There is no second currency here.
ALTER TABLE "PlatformSettings"
  ADD COLUMN IF NOT EXISTS "creatorVerificationPriceNgn"      INTEGER NOT NULL DEFAULT 4999,
  ADD COLUMN IF NOT EXISTS "professionalVerificationPriceNgn" INTEGER NOT NULL DEFAULT 9999;

-- ── 4. The purchases themselves ────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'VerificationKind') THEN
    CREATE TYPE "VerificationKind" AS ENUM ('creator', 'professional');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "VerificationPurchase" (
    "id"               TEXT NOT NULL,
    "wawuUserId"       TEXT NOT NULL,
    "kind"             "VerificationKind" NOT NULL,
    "priceNgn"         INTEGER NOT NULL,
    "flutterwaveTxRef" TEXT NOT NULL,
    "flutterwaveTxId"  TEXT,
    "status"           "TransactionStatus" NOT NULL DEFAULT 'pending',
    "grantedUntil"     TIMESTAMP(3),
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt"        TIMESTAMP(3),
    CONSTRAINT "VerificationPurchase_pkey" PRIMARY KEY ("id")
);

-- Unique because a second settled row on one tx_ref is a tick granted twice
-- for one payment, and because verify looks the row up by it.
CREATE UNIQUE INDEX IF NOT EXISTS "VerificationPurchase_flutterwaveTxRef_key"
  ON "VerificationPurchase"("flutterwaveTxRef");
CREATE INDEX IF NOT EXISTS "VerificationPurchase_wawuUserId_idx"
  ON "VerificationPurchase"("wawuUserId");
CREATE INDEX IF NOT EXISTS "VerificationPurchase_status_idx"
  ON "VerificationPurchase"("status");
CREATE INDEX IF NOT EXISTS "VerificationPurchase_kind_idx"
  ON "VerificationPurchase"("kind");
