-- EVENTS-09 round 2 (D1): the first answer to one scan at the door, kept under
-- the scanner's Idempotency-Key so a scan asked again after its answer was
-- lost gets that first verdict, not "already used" by the scanner's own door.
-- Additive: one new table; no existing table, column, index or row is touched.
--
-- What the database itself guarantees, whatever the code does:
--   * one row per (scanner, key): the primary key is the lock, so two
--     requests with one key, on one Hub process or two, leave one row;
--   * the row goes when its event does (ON DELETE CASCADE).
-- The row is written in the same transaction as the check-in it answers.
--
-- Rollback (nothing else references this table):
--   DROP TABLE "EventDoorScan";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261021070000_event_door_scans';

-- CreateTable
CREATE TABLE "EventDoorScan" (
    "scannerWawuId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "response" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventDoorScan_pkey" PRIMARY KEY ("scannerWawuId","key")
);

-- CreateIndex
CREATE INDEX "EventDoorScan_eventId_idx" ON "EventDoorScan"("eventId");

-- CreateIndex
CREATE INDEX "EventDoorScan_createdAt_idx" ON "EventDoorScan"("createdAt");

-- AddForeignKey
ALTER TABLE "EventDoorScan" ADD CONSTRAINT "EventDoorScan_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
