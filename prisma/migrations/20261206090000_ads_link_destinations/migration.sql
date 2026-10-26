-- ADS-LINK (R-92, owner, 26 Oct 2026): a sponsored card opens the advertiser's web link, or does nothing. Ads are
-- not tied to events. Dashboard: "if you click on the ad, it's going to open up the link. If you don't add the
-- link ... it's not going to do anything."
--
-- Additive. The destination enum gets two labels beside `event`:
--   link  the card (and its button) opens "ctaUrl", an https address, in the phone's browser;
--   none  the card is shown and does nothing: no button, no label, no id, no address.
-- `event` stays, and a campaign that uses it is stored and served exactly as before.
--
-- One new nullable column, "ctaUrl". Two columns lose their NOT NULL: "ctaLabel" (a card that does nothing draws
-- no button, so it has no label) and "ctaDestinationId" (only `event` has one). No row changes: every row that
-- exists is an `event` card with both set, and the CHECK below holds for all of them.
--
-- "AdCreative_cta_check" ties the three columns to the kind, so the database refuses a link without an address,
-- an address on an event, or a button label on a card that does nothing, whatever wrote the row.
-- "AdCreative_ctaUrl_check" is the floor for the address: https, no white space. The rest (public host, no
-- password, no markup, the length cap, the normal form) is the Hub's own check in src/admin/ads/ad-text.ts; the
-- database holds no length limit, as for the other text on the card (ADS-03).
-- The existing "AdCreative_text_check" already treats NULL as passing, so it needs no change.
--
-- The CHECK compares the kind as text, so it does not use the new enum labels while they are being added in the
-- same transaction.
--
-- Rollback (refuses to lose data): run it only when no `link` or `none` card exists, otherwise delete or turn
-- those campaigns into `event` ones first.
--   DO $$ BEGIN
--     IF EXISTS (SELECT 1 FROM "AdCreative" WHERE "ctaDestination"::text <> 'event') THEN
--       RAISE EXCEPTION 'ADS-LINK rollback refused: a link or none card exists';
--     END IF;
--   END $$;
--   ALTER TABLE "AdCreative" DROP CONSTRAINT "AdCreative_ctaUrl_check";
--   ALTER TABLE "AdCreative" DROP CONSTRAINT "AdCreative_cta_check";
--   ALTER TABLE "AdCreative" DROP COLUMN "ctaUrl";
--   ALTER TABLE "AdCreative" ALTER COLUMN "ctaDestinationId" SET NOT NULL;
--   ALTER TABLE "AdCreative" ALTER COLUMN "ctaLabel" SET NOT NULL;
--   (the two enum labels stay: Postgres cannot drop a label, and nothing reads them once no row uses them.)

ALTER TYPE "AdCtaDestination" ADD VALUE IF NOT EXISTS 'link';
ALTER TYPE "AdCtaDestination" ADD VALUE IF NOT EXISTS 'none';

ALTER TABLE "AdCreative" ADD COLUMN "ctaUrl" TEXT;
ALTER TABLE "AdCreative" ALTER COLUMN "ctaLabel" DROP NOT NULL;
ALTER TABLE "AdCreative" ALTER COLUMN "ctaDestinationId" DROP NOT NULL;

ALTER TABLE "AdCreative" ADD CONSTRAINT "AdCreative_cta_check" CHECK (
    ("ctaDestination"::text = 'event' AND "ctaLabel" IS NOT NULL AND "ctaDestinationId" IS NOT NULL AND "ctaUrl" IS NULL)
    OR ("ctaDestination"::text = 'link' AND "ctaLabel" IS NOT NULL AND "ctaDestinationId" IS NULL AND "ctaUrl" IS NOT NULL)
    OR ("ctaDestination"::text = 'none' AND "ctaLabel" IS NULL AND "ctaDestinationId" IS NULL AND "ctaUrl" IS NULL)
);

ALTER TABLE "AdCreative" ADD CONSTRAINT "AdCreative_ctaUrl_check" CHECK ("ctaUrl" IS NULL OR "ctaUrl" ~ '^https://[^[:space:]]+$');
