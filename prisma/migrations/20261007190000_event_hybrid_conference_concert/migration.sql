-- Hybrid events and the Conference and Concert kinds (task EVENTS-02).
--
-- Additive only: three new enum values, nothing renamed or removed. Every row
-- that exists keeps the value it has, so the web and the dashboard read
-- exactly what they read before; only an event submitted with a new value
-- carries one.
ALTER TYPE "EventFormat" ADD VALUE 'hybrid';
ALTER TYPE "EventType" ADD VALUE 'conference';
ALTER TYPE "EventType" ADD VALUE 'concert';
