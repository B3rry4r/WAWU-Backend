-- EVENTS-11 (round 5): a ticket tier that an order points at is retired, not
-- deleted, when a host's PUT /events/:id/tickets drops or changes it.
-- Additive: one nullable column. Null is on sale; a time is when it was
-- retired.
ALTER TABLE "EventTicketType" ADD COLUMN "retiredAt" TIMESTAMP(3);

-- Rollback: ALTER TABLE "EventTicketType" DROP COLUMN "retiredAt";
