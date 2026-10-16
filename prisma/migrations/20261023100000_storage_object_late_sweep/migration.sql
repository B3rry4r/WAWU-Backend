-- ME-04 rounds 3 and 4. Additive only: five nullable columns on "StorageObject".
-- "releasedAt": the person gave the file up (POST /uploads/release).
-- "sweptAt": the Hub's sweep first looked at a given-up file after its upload
--   link had expired (it asked the bucket; it removes the file only when the
--   person released it and no listing uses it, and counts it otherwise).
-- "sweptRemovedAt": that sweep deleted a file it found.
-- "sweptHourAt", "sweptDayAt": the sweep's second look (an hour or more after
--   the first) and third, last look (a day or more after it) at a row whose
--   file had not arrived, for a file that lands very late.
-- No existing row or query changes; no backfill, no default, no index.
ALTER TABLE "StorageObject" ADD COLUMN "releasedAt" TIMESTAMP(3);
ALTER TABLE "StorageObject" ADD COLUMN "sweptAt" TIMESTAMP(3);
ALTER TABLE "StorageObject" ADD COLUMN "sweptRemovedAt" TIMESTAMP(3);
ALTER TABLE "StorageObject" ADD COLUMN "sweptHourAt" TIMESTAMP(3);
ALTER TABLE "StorageObject" ADD COLUMN "sweptDayAt" TIMESTAMP(3);
