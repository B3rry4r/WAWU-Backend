-- A LinkedIn-style experience list on a profile, and the company line beside
-- the location and the website.
--
-- Both are additive and both are nullable or new, so a running instance on
-- the previous release keeps working: `company` defaults to NULL on every
-- existing row and nothing reads it yet, and "ProfileExperience" is a table
-- no deployed code can see. Expand now, contract never: there is nothing
-- here to roll back through.
--
-- MONTH PRECISION, STORED AS A DATE. "startedOn" and "endedOn" are always the
-- first of their month. Nobody remembers the day they started a job and a
-- form that asks invents one, but a real DATE keeps ordering and comparison
-- in the database instead of reimplementing them over a pair of integers.
--
-- A NULL "endedOn" MEANS "STILL THERE". There is deliberately no "current"
-- boolean beside it: two columns that can disagree eventually do, and a row
-- reading current = true with an end date in 2019 has no correct reading.

ALTER TABLE "UserProfile" ADD COLUMN "company" TEXT;

CREATE TABLE "ProfileExperience" (
  "id"          TEXT NOT NULL,
  "wawuUserId"  TEXT NOT NULL,
  "title"       TEXT NOT NULL,
  "company"     TEXT NOT NULL,
  "location"    TEXT,
  "startedOn"   DATE NOT NULL,
  "endedOn"     DATE,
  "description" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ProfileExperience_pkey" PRIMARY KEY ("id")
);

-- Every read of this table is "one person's roles, newest first".
CREATE INDEX "ProfileExperience_wawuUserId_startedOn_idx"
  ON "ProfileExperience"("wawuUserId", "startedOn");

-- ON DELETE CASCADE: an experience row is part of a profile, not a thing in
-- its own right. A deleted profile must not leave its job history behind.
ALTER TABLE "ProfileExperience"
  ADD CONSTRAINT "ProfileExperience_wawuUserId_fkey"
  FOREIGN KEY ("wawuUserId") REFERENCES "UserProfile"("wawuUserId")
  ON DELETE CASCADE ON UPDATE CASCADE;
