-- Partner services, as the Marketplace "Featured Services" rail draws them.
--
-- The rail wants four things per card and the table had none of them in a
-- usable form: an image (`icon` is a glyph name, not a picture), a category
-- label, a floor price a client can format as "From NGN 10,000" (`priceFrom`
-- is free text -- "NGN 25,000" -- which cannot be compared, sorted or
-- re-formatted), and a way to say which services are on the rail at all.
--
-- `priceFrom` is kept, unchanged. It is what the existing service detail
-- screen prints, and rewriting it into a number would break that read for the
-- sake of a new one. The numeric column is the authoritative one for anything
-- that has to do arithmetic.
--
-- Every column here is nullable or defaulted, and nothing is backfilled: a
-- service with no image and no numeric price renders exactly as it does
-- today, and `featured` starts false for every row, so the rail is empty
-- until an admin fills it rather than guessing at an editorial decision.

ALTER TABLE "PartnerService"
  ADD COLUMN "imageUrl"       TEXT,
  ADD COLUMN "category"       TEXT,
  ADD COLUMN "priceFromNaira" INTEGER,
  ADD COLUMN "featured"       BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "PartnerService_featured_idx" ON "PartnerService"("featured");
