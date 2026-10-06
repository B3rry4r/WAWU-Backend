-- EVENTS-05: door staff a host can add, so someone other than the host can
-- check tickets in (E19 to E24).
--
-- Additive only: one new table. No existing table, column, index or row is
-- touched.
--
-- Rollback:
--   DROP TABLE "EventDoorStaff";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261005090000_event_door_staff';

-- CreateTable
CREATE TABLE "EventDoorStaff" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "staffWawuId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "EventDoorStaff_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EventDoorStaff_staffWawuId_idx" ON "EventDoorStaff"("staffWawuId");

-- CreateIndex
CREATE UNIQUE INDEX "EventDoorStaff_eventId_staffWawuId_key" ON "EventDoorStaff"("eventId", "staffWawuId");

-- AddForeignKey
ALTER TABLE "EventDoorStaff" ADD CONSTRAINT "EventDoorStaff_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
