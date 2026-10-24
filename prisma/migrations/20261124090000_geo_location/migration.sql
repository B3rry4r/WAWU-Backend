-- GEO-02 (R-85). Where a person is, as data: a country, a region and a city. Additive only: five nullable columns on
-- "ProfileDetails" (its own table, not "UserProfile": GET and PATCH /users/me return the whole UserProfile row, so a column
-- there would widen two responses the web reads) and one index. Nothing the web or the dashboard calls reads or writes them.
--
-- Existing accounts get their country from their phone (+234 is Nigeria). This service holds a phone only where a person
-- proved one for a wallet ("WalletIdentity"."verifiedPhone", "FintavaWalletOpening"."phone", both E.164); every other
-- account has no phone here and is filled from WAWU ID's token the first time the app asks for GET /me/location.
-- A row that already has a country is never touched. Rollback: rollback.sql next to this file.

ALTER TABLE "ProfileDetails" ADD COLUMN "countryCode" TEXT;
ALTER TABLE "ProfileDetails" ADD COLUMN "regionCode" TEXT;
ALTER TABLE "ProfileDetails" ADD COLUMN "regionName" TEXT;
ALTER TABLE "ProfileDetails" ADD COLUMN "city" TEXT;
ALTER TABLE "ProfileDetails" ADD COLUMN "countrySource" TEXT;

CREATE INDEX "ProfileDetails_countryCode_regionCode_idx" ON "ProfileDetails"("countryCode", "regionCode");

INSERT INTO "ProfileDetails" ("wawuUserId", "countryCode", "countrySource", "updatedAt")
SELECT p."wawuUserId", 'NG', 'phone', NOW()
FROM "UserProfile" p
WHERE EXISTS (SELECT 1 FROM "WalletIdentity" w WHERE w."wawuUserId" = p."wawuUserId" AND w."verifiedPhone" LIKE '+234%')
   OR EXISTS (SELECT 1 FROM "FintavaWalletOpening" o WHERE o."wawuUserId" = p."wawuUserId" AND o."phone" LIKE '+234%')
ON CONFLICT ("wawuUserId") DO UPDATE
  SET "countryCode" = 'NG', "countrySource" = 'phone', "updatedAt" = NOW()
  WHERE "ProfileDetails"."countryCode" IS NULL;
