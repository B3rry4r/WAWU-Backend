-- Event ticketing: create, sell, check in, get paid.
--
-- Four new tables, four new enums, one new value on EventStatus, and six new
-- columns on Event. The Event columns are the only ALTER, and they are all
-- nullable or defaulted, so every existing row stays valid and every existing
-- event keeps behaving as the free, interest-only event it was.
--
-- Hazard H-1 does not apply to the Event columns: `EventView` in
-- src/event/event-view.type.ts is a DECLARED interface built by a mapper, not
-- a Prisma re-export returned by spread, so a new column cannot appear in the
-- app's responses without somebody adding it to the mapper on purpose.

CREATE TYPE "EventCategory" AS ENUM ('music','business','training','conference','church','entertainment','fashion','community','lifestyle','other');
CREATE TYPE "TicketTier" AS ENUM ('regular','vip','vvip','early_bird','group','free');
CREATE TYPE "EventOrderStatus" AS ENUM ('pending','paid','refunded','failed');
CREATE TYPE "EventTicketStatus" AS ENUM ('valid','checked_in','void');

ALTER TYPE "EventStatus" ADD VALUE IF NOT EXISTS 'cancelled';

ALTER TABLE "Event"
  ADD COLUMN "bannerUrl"    TEXT,
  ADD COLUMN "category"     "EventCategory" NOT NULL DEFAULT 'other',
  ADD COLUMN "contactEmail" TEXT,
  ADD COLUMN "contactPhone" TEXT,
  ADD COLUMN "cancelledAt"  TIMESTAMP(3),
  ADD COLUMN "cancelReason" TEXT;

CREATE TABLE "EventTicketType" (
  "id"           TEXT NOT NULL,
  "eventId"      TEXT NOT NULL,
  "tier"         "TicketTier" NOT NULL,
  "name"         TEXT NOT NULL,
  "priceNaira"   INTEGER NOT NULL,
  "quantity"     INTEGER NOT NULL,
  "sold"         INTEGER NOT NULL DEFAULT 0,
  "salesStartAt" TIMESTAMP(3),
  "salesEndAt"   TIMESTAMP(3),
  CONSTRAINT "EventTicketType_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EventOrder" (
  "id"               TEXT NOT NULL,
  "eventId"          TEXT NOT NULL,
  "ticketTypeId"     TEXT NOT NULL,
  "buyerWawuId"      TEXT NOT NULL,
  "quantity"         INTEGER NOT NULL,
  "amountNaira"      INTEGER NOT NULL,
  "commissionRate"   DECIMAL(5,4) NOT NULL,
  "status"           "EventOrderStatus" NOT NULL DEFAULT 'pending',
  "flutterwaveTxRef" TEXT NOT NULL,
  "flutterwaveTxId"  TEXT,
  "referralCode"     TEXT,
  "refundedAt"       TIMESTAMP(3),
  "refundReference"  TEXT,
  "refundError"      TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EventOrder_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EventTicket" (
  "id"           TEXT NOT NULL,
  "orderId"      TEXT NOT NULL,
  "eventId"      TEXT NOT NULL,
  "ticketTypeId" TEXT NOT NULL,
  "code"         TEXT NOT NULL,
  "status"       "EventTicketStatus" NOT NULL DEFAULT 'valid',
  "checkedInAt"  TIMESTAMP(3),
  "checkedInBy"  TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EventTicket_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EventReferral" (
  "id"          TEXT NOT NULL,
  "eventId"     TEXT NOT NULL,
  "code"        TEXT NOT NULL,
  "label"       TEXT NOT NULL,
  "ownerWawuId" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EventReferral_pkey" PRIMARY KEY ("id")
);

-- A ticket code and a referral code are both scanned or typed by strangers;
-- uniqueness is enforced by the database rather than by hoping.
CREATE UNIQUE INDEX "EventOrder_flutterwaveTxRef_key" ON "EventOrder" ("flutterwaveTxRef");
CREATE UNIQUE INDEX "EventTicket_code_key" ON "EventTicket" ("code");
CREATE UNIQUE INDEX "EventReferral_code_key" ON "EventReferral" ("code");

CREATE INDEX "EventTicketType_eventId_idx"   ON "EventTicketType" ("eventId");
CREATE INDEX "EventOrder_eventId_status_idx" ON "EventOrder" ("eventId", "status");
CREATE INDEX "EventOrder_buyerWawuId_idx"    ON "EventOrder" ("buyerWawuId");
CREATE INDEX "EventOrder_referralCode_idx"   ON "EventOrder" ("referralCode");
CREATE INDEX "EventTicket_eventId_status_idx" ON "EventTicket" ("eventId", "status");
CREATE INDEX "EventTicket_orderId_idx"        ON "EventTicket" ("orderId");
CREATE INDEX "EventReferral_eventId_idx"      ON "EventReferral" ("eventId");

ALTER TABLE "EventTicketType" ADD CONSTRAINT "EventTicketType_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EventOrder" ADD CONSTRAINT "EventOrder_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EventOrder" ADD CONSTRAINT "EventOrder_ticketTypeId_fkey"
  FOREIGN KEY ("ticketTypeId") REFERENCES "EventTicketType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EventTicket" ADD CONSTRAINT "EventTicket_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "EventOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EventTicket" ADD CONSTRAINT "EventTicket_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EventTicket" ADD CONSTRAINT "EventTicket_ticketTypeId_fkey"
  FOREIGN KEY ("ticketTypeId") REFERENCES "EventTicketType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EventReferral" ADD CONSTRAINT "EventReferral_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
