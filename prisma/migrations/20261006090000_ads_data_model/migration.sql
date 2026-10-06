-- Ads data model (task ADS-03, R-15): sponsored cards booked by the WAWU team.
--
-- Additive only: three new enum types and two new tables. No existing table,
-- column, index or row is touched. (`prisma migrate diff` against a database
-- built from every earlier migration also proposes dropping
-- "ContentPiece_specializations_idx", the GIN index that
-- 20260921090000_content_specializations adds in raw SQL and the schema
-- cannot express; that line is not part of this migration.)
--
-- R-15: ads are invoiced by hand, so there is no price, advertiser account or
-- payment column. The tables hold no personal data: no column names a WAWU
-- user.
--
-- The card (H33 in the TGIF reader, H36 in TGIF's place on Today):
--   AdCampaign   the booking: advertiser, placement, window, status, weight.
--   AdCreative   the card: headline, subline, button label and destination,
--                artwork. One per campaign ("AdCreative_campaignId_key").
--
-- Where each rule lives:
--   Placement (tgif_card, today_slot), status (draft, scheduled, live, paused,
--   ended) and the CTA destination ALLOW-LIST are Postgres enums, so a value
--   outside them cannot be stored. The allow-list is "AdCtaDestination": today
--   `event`, which opens the event detail for "ctaDestinationId" (an Event id).
--   A new destination is `ALTER TYPE "AdCtaDestination" ADD VALUE`, in the
--   task that builds it. ADS-06 (admin routes) checks the value against the
--   enum in its DTO and, for `event`, that the Event exists and is approved,
--   before it writes; ADS-04 (serving) checks the event is still open when it
--   serves. There is no foreign key to Event: the id's table depends on the
--   kind, and an FK would stop an event being deleted.
--   The CHECKs at the end are the database's own floor. Prisma does not model
--   CHECK constraints, so they do not show as drift.
--
-- Serving (ADS-04): a card is served when its campaign has the placement, a
-- status of `scheduled` or `live`, and "startsAt" <= now < "endsAt"; the
-- highest "weight" wins. "AdCampaign_placement_status_startsAt_endsAt_idx"
-- serves exactly that filter. ADS-05's views and taps reference
-- "AdCampaign"."id" or "AdCreative"."id" from their own tables.
--
-- Deleting a campaign deletes its creative (ON DELETE CASCADE): the card has
-- no meaning without its booking. Nothing refers to either table yet.
--
-- Rollback: DROP TABLE "AdCreative"; DROP TABLE "AdCampaign";
--           DROP TYPE "AdCtaDestination"; DROP TYPE "AdCampaignStatus";
--           DROP TYPE "AdPlacement";


-- CreateEnum
CREATE TYPE "AdPlacement" AS ENUM ('tgif_card', 'today_slot');

-- CreateEnum
CREATE TYPE "AdCampaignStatus" AS ENUM ('draft', 'scheduled', 'live', 'paused', 'ended');

-- CreateEnum
CREATE TYPE "AdCtaDestination" AS ENUM ('event');

-- CreateTable
CREATE TABLE "AdCampaign" (
    "id" TEXT NOT NULL,
    "advertiser" TEXT NOT NULL,
    "placement" "AdPlacement" NOT NULL,
    "status" "AdCampaignStatus" NOT NULL DEFAULT 'draft',
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdCreative" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "headline" TEXT NOT NULL,
    "subline" TEXT,
    "ctaLabel" TEXT NOT NULL,
    "ctaDestination" "AdCtaDestination" NOT NULL,
    "ctaDestinationId" TEXT NOT NULL,
    "artworkUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdCreative_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdCampaign_placement_status_startsAt_endsAt_idx" ON "AdCampaign"("placement", "status", "startsAt", "endsAt");

-- CreateIndex
CREATE UNIQUE INDEX "AdCreative_campaignId_key" ON "AdCreative"("campaignId");

-- AddForeignKey
ALTER TABLE "AdCreative" ADD CONSTRAINT "AdCreative_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "AdCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A booking runs for a positive length of time.
ALTER TABLE "AdCampaign" ADD CONSTRAINT "AdCampaign_window_check" CHECK ("endsAt" > "startsAt");

-- 1 to 100, whole numbers.
-- PROVISIONAL(ADS-WEIGHT-RANGE, owner=DEV2, why=no ruling names a weight range; ADS-06 and the dashboard's schedule form read 1 and 100 from here)
ALTER TABLE "AdCampaign" ADD CONSTRAINT "AdCampaign_weight_check" CHECK ("weight" BETWEEN 1 AND 100);

-- A card is never drawn with an empty name, headline, button or destination
-- (empty or only white space).
ALTER TABLE "AdCampaign" ADD CONSTRAINT "AdCampaign_advertiser_check" CHECK ("advertiser" !~ '^\s*$');
ALTER TABLE "AdCreative" ADD CONSTRAINT "AdCreative_text_check" CHECK (
    "headline" !~ '^\s*$'
    AND "ctaLabel" !~ '^\s*$'
    AND "ctaDestinationId" !~ '^\s*$'
    AND ("subline" IS NULL OR "subline" !~ '^\s*$')
);

-- Artwork is a web link a client will load: http or https, never javascript: or data:.
ALTER TABLE "AdCreative" ADD CONSTRAINT "AdCreative_artworkUrl_check" CHECK ("artworkUrl" IS NULL OR "artworkUrl" ~* '^https?://[^[:space:]]+$');
