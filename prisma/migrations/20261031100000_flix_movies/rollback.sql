\set ON_ERROR_STOP on
-- Rollback of 20261031100000_flix_movies (FLIX-01). Nothing else references
-- these tables. Run it only after the Hub build that reads them is gone.
-- Run with: psql -1 -f rollback.sql
-- Refuses (and changes nothing) while any person's link or consent is stored:
-- "MoviePartnerLink" is the record that a person has an account on the movie
-- partner's side (it is also the note that a deleted person's account there is
-- still to be closed by hand), and "MoviePartnerConsent" holds the agreement
-- they gave and when. Both are worth archiving; copy them out first only if you
-- mean to lose them. The catalog copy and the sync marker are rebuilt by the
-- next sync pass and do not stop it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "MoviePartnerLink")
     OR EXISTS (SELECT 1 FROM "MoviePartnerConsent") THEN
    RAISE EXCEPTION 'FLIX-01 rollback: partner links or consents are stored and would be lost. Nothing was changed.';
  END IF;
END $$;
DROP TABLE "MoviePartnerConsent";
DROP TABLE "MoviePartnerLink";
DROP TABLE "MoviePartnerSync";
DROP TABLE "MoviePartnerMovie";
