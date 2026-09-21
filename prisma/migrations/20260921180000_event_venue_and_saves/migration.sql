-- Events: the venue by name, and a bookmark per viewer.
--
-- Both are things the approved Events screen draws and the wire could not
-- answer. The hero card shows a venue under a map pin while the trending
-- cards show "Concert • Abuja"; `Event.location` was documented as "city OR
-- venue name", so one column was being asked to be both. And the ribbon in
-- the hero's corner, and the heart on each trending card, had no state behind
-- them at all -- there was no per-viewer save for an event anywhere in this
-- schema (SavedItem is ContentPiece, MarketplaceSave is an external shop id).
--
-- Additive only. `venueName` is nullable, so every existing event stays valid
-- and a client with nothing there falls back to `location`, exactly as it
-- behaves today. EventSave is a new table nothing reads until the deploy that
-- reads it, so an older instance keeps working against this schema unchanged.

ALTER TABLE "Event" ADD COLUMN "venueName" TEXT;

-- Shaped like EventGoing on purpose: one row per (event, user), and the
-- unique constraint IS the idempotency, so saving twice is one save and
-- unsaving something never saved is still the right end state.
CREATE TABLE "EventSave" (
  "id"         TEXT NOT NULL,
  "eventId"    TEXT NOT NULL,
  "userWawuId" TEXT NOT NULL,
  "savedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EventSave_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EventSave_eventId_userWawuId_key" ON "EventSave"("eventId", "userWawuId");
CREATE INDEX "EventSave_eventId_idx"    ON "EventSave"("eventId");
CREATE INDEX "EventSave_userWawuId_idx" ON "EventSave"("userWawuId");

ALTER TABLE "EventSave"
  ADD CONSTRAINT "EventSave_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
