-- ME-04 round 3. Additive only: three nullable columns on "StorageObject".
-- "releasedAt": the person gave the file up (POST /uploads/release).
-- "sweptAt": the Hub's sweep settled a given-up file after its upload link
--   had expired (it looked at the bucket and removed the file if present).
-- "sweptRemovedAt": that sweep deleted a file it found.
-- No existing row or query changes; no backfill.
ALTER TABLE "StorageObject" ADD COLUMN "releasedAt" TIMESTAMP(3);
ALTER TABLE "StorageObject" ADD COLUMN "sweptAt" TIMESTAMP(3);
ALTER TABLE "StorageObject" ADD COLUMN "sweptRemovedAt" TIMESTAMP(3);
