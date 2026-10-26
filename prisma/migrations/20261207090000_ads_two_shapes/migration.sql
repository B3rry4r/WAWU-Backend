-- ADS-LINK round 2 (R-92, owner, 26 Oct 2026): an ad has TWO shapes, not three places. A LANDSCAPE picture (16:9,
-- 1920 x 1080) shows in the Explore slider AND on the Today strip; a PORTRAIT picture (1080 x 2340, a phone screen)
-- shows in the TGIF full screen. One booking takes one picture per shape, each optional, at least one required. Where
-- an ad shows follows from the pictures it has: landscape only = Explore and Today and never TGIF; portrait only =
-- TGIF only; both = all three. The dashboard no longer asks for a placement.
--
-- Additive. Two nullable columns on "AdCreative":
--   "artworkLandscapeUrl"  the landscape picture (http or https address);
--   "artworkPortraitUrl"   the portrait picture.
-- Nothing is rewritten and no existing row changes. A booking saved before this keeps its single "artworkUrl" and its
-- "AdCampaign"."placement" and is served EXACTLY as before, in that one place: an explore_slider or today_slot booking
-- counts as landscape for its own place only, a tgif_card booking as portrait. (Rows are deliberately not copied into
-- the new columns: that would put an old explore_slider booking on the Today strip as well.)
--
-- Two CHECKs:
--   "AdCreative_pictures_check"   a card holds either the single old picture or the two-shape pictures, never both, so
--                                 the Hub (and anything else) can tell the two kinds of booking apart from the row;
--   "AdCreative_shapes_url_check" each new picture is absent or an http(s) address with no white space, as
--                                 "AdCreative_artworkUrl_check" says for the old one.
-- "A booking has at least one picture" is the Hub's rule (422 in POST and PATCH /admin/ads, and on schedule and
-- resume), not a CHECK: campaigns saved before R-59 have no picture and must stay readable and endable.
--
-- Rollback (refuses to lose data): run it only when no booking holds a two-shape picture, otherwise move those
-- bookings back to a single picture first.
--   DO $$ BEGIN
--     IF EXISTS (SELECT 1 FROM "AdCreative" WHERE "artworkLandscapeUrl" IS NOT NULL OR "artworkPortraitUrl" IS NOT NULL) THEN
--       RAISE EXCEPTION 'ADS two-shapes rollback refused: a booking holds a landscape or portrait picture';
--     END IF;
--   END $$;
--   ALTER TABLE "AdCreative" DROP CONSTRAINT "AdCreative_shapes_url_check";
--   ALTER TABLE "AdCreative" DROP CONSTRAINT "AdCreative_pictures_check";
--   ALTER TABLE "AdCreative" DROP COLUMN "artworkPortraitUrl";
--   ALTER TABLE "AdCreative" DROP COLUMN "artworkLandscapeUrl";

ALTER TABLE "AdCreative" ADD COLUMN "artworkLandscapeUrl" TEXT;
ALTER TABLE "AdCreative" ADD COLUMN "artworkPortraitUrl" TEXT;

ALTER TABLE "AdCreative" ADD CONSTRAINT "AdCreative_pictures_check" CHECK (
    "artworkUrl" IS NULL OR ("artworkLandscapeUrl" IS NULL AND "artworkPortraitUrl" IS NULL)
);

ALTER TABLE "AdCreative" ADD CONSTRAINT "AdCreative_shapes_url_check" CHECK (
    ("artworkLandscapeUrl" IS NULL OR "artworkLandscapeUrl" ~* '^https?://[^[:space:]]+$')
    AND ("artworkPortraitUrl" IS NULL OR "artworkPortraitUrl" ~* '^https?://[^[:space:]]+$')
);
