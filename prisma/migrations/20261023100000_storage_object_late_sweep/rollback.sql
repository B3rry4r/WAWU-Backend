-- Rollback for 20261023100000_storage_object_late_sweep. Run by hand, never by
-- `prisma migrate deploy` (it only reads migration.sql). Drops the five
-- columns; every other column and row is untouched. Afterwards, delete the
-- row for this migration from "_prisma_migrations" so a redeploy can reapply.
ALTER TABLE "StorageObject"
    DROP COLUMN "releasedAt",
    DROP COLUMN "sweptAt",
    DROP COLUMN "sweptRemovedAt",
    DROP COLUMN "sweptHourAt",
    DROP COLUMN "sweptDayAt";
