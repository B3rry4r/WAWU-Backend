-- Profile views, for the "12.4K / Profile Views / This month" stat card.
--
-- A counter column cannot answer "this month" and drifts the first time a row
-- is removed, so this is a record of views and the figure is a COUNT over a
-- window. Nothing else in this schema could stand in for it: followers,
-- content and purchases are all different facts.
--
-- ONE ROW PER VIEWER PER DAY, which the unique key enforces. A number that
-- climbs every time somebody refreshes is not a measure of interest, and it
-- is the easiest figure on that screen to inflate on purpose. Anonymous reads
-- write nothing at all -- there is no viewer to attribute them to and no way
-- to tell a script from a person -- and neither does the owner looking at
-- their own page.
--
-- A new table, so no deployed instance can see it and nothing existing moves.

CREATE TABLE "ProfileView" (
  "id"            TEXT NOT NULL,
  "profileWawuId" TEXT NOT NULL,
  "viewerWawuId"  TEXT NOT NULL,
  "viewedOn"      DATE NOT NULL,
  "viewedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProfileView_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProfileView_profileWawuId_viewerWawuId_viewedOn_key" ON "ProfileView"("profileWawuId", "viewerWawuId", "viewedOn");
-- The read is always "this profile, inside this window".
CREATE INDEX "ProfileView_profileWawuId_viewedOn_idx" ON "ProfileView"("profileWawuId", "viewedOn");
