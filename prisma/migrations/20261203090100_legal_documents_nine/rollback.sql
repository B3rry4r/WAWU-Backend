\set ON_ERROR_STOP on
-- Rollback of 20261203090100_legal_documents_nine (LEGAL-DOCS). Run it only after the Hub build that serves the nine slugs is gone.
-- Run with: psql -1 -f rollback.sql
-- Refuses (and changes nothing) while any of the nine documents has been saved since the migration wrote it: the migration gave
-- every row the fixed "updatedAt" 2026-10-26 12:00:00, and a save from the dashboard sets the time of the save, so a different
-- "updatedAt" is the owner's edit, which deleting would lose. Settle it first (the owner keeps the text, then it is removed by hand).
-- With nobody's edit to lose it removes the seven documents the previous Hub build cannot read (cookies, creator-monetization,
-- verification-refund, acceptable-use, partner-dpa, community-guidelines, disclaimer). It leaves "terms" and "privacy": the previous
-- build reads those two, and what the migration replaced there (a version the owner had saved) was not kept, so there is nothing
-- older to put back; the owner's newer wording stays in force.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "LegalDocument"
    WHERE "slug" IN ('privacy', 'terms', 'cookies', 'creator-monetization', 'verification-refund', 'acceptable-use', 'partner-dpa', 'community-guidelines', 'disclaimer')
      AND "updatedAt" <> TIMESTAMP '2026-10-26 12:00:00.000'
  ) THEN
    RAISE EXCEPTION 'LEGAL-DOCS rollback: a legal document has been saved since the migration wrote it, and deleting it would lose the owner''s edit. Nothing was changed.';
  END IF;
END $$;
DELETE FROM "LegalDocument"
WHERE "slug" IN ('cookies', 'creator-monetization', 'verification-refund', 'acceptable-use', 'partner-dpa', 'community-guidelines', 'disclaimer');
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261203090100_legal_documents_nine';
