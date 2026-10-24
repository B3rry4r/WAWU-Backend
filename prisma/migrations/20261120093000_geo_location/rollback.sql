\set ON_ERROR_STOP on
-- Rollback of 20261120093000_geo_location (GEO-02). Run it only after the Hub build that reads these columns is gone.
-- Run with: psql -1 -f rollback.sql
-- Refuses (and changes nothing) while any row holds something a person chose or typed: a region, a city, or a country
-- they picked themselves (countrySource 'profile'). Dropping the columns would lose it. A country that came from WAWU ID
-- or from a phone ('wawu_id', 'phone') is worked out again from those, so it may go.
-- Rows the migration inserted only to hold such a country are removed with it; a row that existed before keeps its other fields.
-- To clear what people chose on purpose first:
--   UPDATE "ProfileDetails" SET "countryCode" = NULL, "regionCode" = NULL, "regionName" = NULL, "city" = NULL, "countrySource" = NULL;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "ProfileDetails"
    WHERE "regionCode" IS NOT NULL OR "regionName" IS NOT NULL OR "city" IS NOT NULL
       OR ("countryCode" IS NOT NULL AND "countrySource" IS DISTINCT FROM 'wawu_id' AND "countrySource" IS DISTINCT FROM 'phone')
  ) THEN
    RAISE EXCEPTION 'GEO-02 rollback: people have saved a country, region or city and would lose it. Nothing was changed.';
  END IF;
END $$;
DELETE FROM "ProfileDetails"
WHERE "countrySource" IN ('wawu_id', 'phone')
  AND "location" IS NULL AND "threadsHandle" IS NULL
  AND cardinality("skills") = 0 AND cardinality("openTo") = 0 AND cardinality("socialOrder") = 0;
DROP INDEX "ProfileDetails_countryCode_regionCode_idx";
ALTER TABLE "ProfileDetails" DROP COLUMN "countrySource";
ALTER TABLE "ProfileDetails" DROP COLUMN "city";
ALTER TABLE "ProfileDetails" DROP COLUMN "regionName";
ALTER TABLE "ProfileDetails" DROP COLUMN "regionCode";
ALTER TABLE "ProfileDetails" DROP COLUMN "countryCode";
