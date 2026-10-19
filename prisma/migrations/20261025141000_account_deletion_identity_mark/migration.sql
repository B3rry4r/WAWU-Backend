-- SETTINGS-08 (G-SETTINGS-08-1). Additive. Whether WAWU ID has confirmed the
-- Hub's mark-deletion call for a deletion, and the retry state for one it has
-- not. Existing rows get no confirmation: the hourly pass asks WAWU ID for each
-- (the call is idempotent there) before any of them is purged.
ALTER TABLE "AccountDeletion"
  ADD COLUMN "identityMarkedAt" TIMESTAMP(3),
  ADD COLUMN "identityMarkAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "identityMarkNextAt" TIMESTAMP(3);
