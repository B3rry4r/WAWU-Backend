-- ME-04 rounds 3 to 5. Additive only: six nullable columns on "StorageObject".
-- "releasedAt": the person gave the file up (POST /uploads/release).
-- "sweptAt": the Hub's sweep first looked at a given-up file after its upload
--   link had expired (it asked the bucket; it removes the file only when the
--   person released it and no listing uses it, and counts it otherwise).
-- "sweptRemovedAt": that sweep deleted a file it found.
-- "sweptHourAt", "sweptDayAt": the sweep's second look (an hour or more after
--   the first) and third, last look (a day or more after it) at a row whose
--   file had not arrived, for a file that lands very late.
-- "removingAt": a removal of the file from the bucket is under way (a release,
--   or the sweep). Set and cleared under the person's lock; nothing is held
--   while the bucket is called, and a mark older than a couple of minutes is a
--   removal that never finished, which the sweep takes over (round 5).
-- No existing row or query changes; no backfill, no default, no index.
ALTER TABLE "StorageObject" ADD COLUMN "releasedAt" TIMESTAMP(3);
ALTER TABLE "StorageObject" ADD COLUMN "sweptAt" TIMESTAMP(3);
ALTER TABLE "StorageObject" ADD COLUMN "sweptRemovedAt" TIMESTAMP(3);
ALTER TABLE "StorageObject" ADD COLUMN "sweptHourAt" TIMESTAMP(3);
ALTER TABLE "StorageObject" ADD COLUMN "sweptDayAt" TIMESTAMP(3);
ALTER TABLE "StorageObject" ADD COLUMN "removingAt" TIMESTAMP(3);
