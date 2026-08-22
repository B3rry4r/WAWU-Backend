-- Events — reinstated 22 Aug 2026 by product-owner decision.
--
-- ADDITIVE ONLY. Four new enum types, four new tables, their indexes, and two
-- foreign keys that both point at a table created in this same file. There is
-- no ALTER on any pre-existing table below, and that is the point: hazard H-1
-- records that most wire types in src/common/types are bare re-exports of
-- their Prisma model returned by spread, so a new column on an EXISTING table
-- would appear verbatim in the SHIPPED app's responses without a line of
-- application code changing. New tables cannot do that.
--
-- NO MONEY. What docs/01_SPEC.md cut was event TICKETS, and that stays cut:
-- there is no price, currency, amount, ticket, purchase, payment reference or
-- credit cost in any column created here, and none may be added. "Going" is an
-- interest signal — a row in "EventGoing" exists or it does not, and the
-- UNIQUE (eventId, userWawuId) below IS the idempotency. Paid registration, if
-- an organiser runs one, lives on their own site behind "Event"."externalUrl".
--
-- Every status has an exit (see the EventStatus doc comment in schema.prisma):
-- pending is reachable from rejected and published by a host edit, published
-- from pending by approve and from removed by restore. A pending row no
-- endpoint can move is the worst bug this codebase has shipped; it is not
-- being recreated here.
-- CreateEnum
CREATE TYPE "EventFormat" AS ENUM ('in_person', 'online');

-- CreateEnum
CREATE TYPE "EventType" AS ENUM ('workshop', 'summit', 'webinar', 'meetup', 'competition');

-- CreateEnum
CREATE TYPE "EventStatus" AS ENUM ('pending', 'published', 'rejected', 'removed');

-- CreateEnum
CREATE TYPE "AdminEventAction" AS ENUM ('approved', 'rejected', 'featured', 'unfeatured', 'removed', 'restored');

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "hostWawuId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "hostOrg" TEXT NOT NULL,
    "hostOrgBio" TEXT,
    "format" "EventFormat" NOT NULL,
    "type" "EventType" NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "timeLabel" TEXT,
    "timezone" TEXT,
    "location" TEXT NOT NULL,
    "address" TEXT,
    "externalUrl" TEXT,
    "recapUrl" TEXT,
    "recapText" TEXT,
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "status" "EventStatus" NOT NULL DEFAULT 'pending',
    "lastDecisionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventSpeaker" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT,
    "order" INTEGER NOT NULL,

    CONSTRAINT "EventSpeaker_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventGoing" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "userWawuId" TEXT NOT NULL,
    "markedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventGoing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminEventReview" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "hostWawuId" TEXT NOT NULL,
    "action" "AdminEventAction" NOT NULL,
    "previousStatus" "EventStatus" NOT NULL,
    "newStatus" "EventStatus" NOT NULL,
    "previousFeatured" BOOLEAN NOT NULL,
    "newFeatured" BOOLEAN NOT NULL,
    "reason" TEXT,
    "reviewedByAdminId" TEXT NOT NULL,
    "reviewedByAdminEmail" TEXT NOT NULL,
    "reviewedByAdminRole" "AdminRole" NOT NULL,
    "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminEventReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Event_hostWawuId_idx" ON "Event"("hostWawuId");

-- CreateIndex
CREATE INDEX "Event_status_idx" ON "Event"("status");

-- CreateIndex
CREATE INDEX "Event_status_startsAt_idx" ON "Event"("status", "startsAt");

-- CreateIndex
CREATE INDEX "Event_status_featured_idx" ON "Event"("status", "featured");

-- CreateIndex
CREATE INDEX "Event_format_idx" ON "Event"("format");

-- CreateIndex
CREATE INDEX "Event_type_idx" ON "Event"("type");

-- CreateIndex
CREATE INDEX "EventSpeaker_eventId_idx" ON "EventSpeaker"("eventId");

-- CreateIndex
CREATE INDEX "EventGoing_eventId_idx" ON "EventGoing"("eventId");

-- CreateIndex
CREATE INDEX "EventGoing_userWawuId_idx" ON "EventGoing"("userWawuId");

-- CreateIndex
CREATE UNIQUE INDEX "EventGoing_eventId_userWawuId_key" ON "EventGoing"("eventId", "userWawuId");

-- CreateIndex
CREATE INDEX "AdminEventReview_eventId_idx" ON "AdminEventReview"("eventId");

-- CreateIndex
CREATE INDEX "AdminEventReview_reviewedByAdminId_idx" ON "AdminEventReview"("reviewedByAdminId");

-- CreateIndex
CREATE INDEX "AdminEventReview_reviewedAt_idx" ON "AdminEventReview"("reviewedAt");

-- AddForeignKey
ALTER TABLE "EventSpeaker" ADD CONSTRAINT "EventSpeaker_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventGoing" ADD CONSTRAINT "EventGoing_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
