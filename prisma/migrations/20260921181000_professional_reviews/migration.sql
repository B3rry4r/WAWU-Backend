-- Reviews on a professional listing, so that a star rating is a fact.
--
-- The approved Services screen draws "4.9 (120 reviews)" next to every
-- professional, above a Book button, and the API could produce neither
-- figure. The alternative on offer was a `rating` float on
-- ProfessionalProfile with nothing to write it, which is how a made-up 4.8
-- ends up under every name in a directory of lawyers and doctors --
-- `Product.ratingAvg` already carries the note saying exactly that.
--
-- So: real rows, with a real write path, and NO stored average anywhere. The
-- average and the count are aggregated on read, which means there is one
-- definition of them and nothing to drift when a review is edited or removed.
-- A listing with no reviews reports null, and its card draws no stars.
--
-- WHO MAY WRITE ONE is enforced in the service, not here: a review needs a
-- DirectMessage from the author to that professional which the professional
-- actually responded to. `stars` is bounded 1..5 in the DTO rather than by a
-- CHECK, so an out-of-range value comes back as an explained 400 instead of a
-- database error the API cannot translate.
--
-- A new table, so nothing already deployed can see it and nothing existing
-- moves.

CREATE TABLE "ProfessionalReview" (
  "id"             TEXT NOT NULL,
  "professionalId" TEXT NOT NULL,
  "authorWawuId"   TEXT NOT NULL,
  "stars"          INTEGER NOT NULL,
  "body"           TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProfessionalReview_pkey" PRIMARY KEY ("id")
);

-- Per LISTING, not per person: someone listed in two categories is being
-- judged on two different pieces of work, and a review of their legal advice
-- does not transfer to their photography. One review per client per listing.
CREATE UNIQUE INDEX "ProfessionalReview_professionalId_authorWawuId_key" ON "ProfessionalReview"("professionalId", "authorWawuId");
CREATE INDEX "ProfessionalReview_professionalId_idx" ON "ProfessionalReview"("professionalId");
CREATE INDEX "ProfessionalReview_authorWawuId_idx"   ON "ProfessionalReview"("authorWawuId");

ALTER TABLE "ProfessionalReview"
  ADD CONSTRAINT "ProfessionalReview_professionalId_fkey"
  FOREIGN KEY ("professionalId") REFERENCES "ProfessionalProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
