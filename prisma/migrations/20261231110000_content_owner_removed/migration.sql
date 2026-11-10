-- CREATOR-TAKEDOWN (R-130): when a creator took their own piece down. Nullable, no default, nothing backfilled.
ALTER TABLE "ContentPiece" ADD COLUMN "ownerRemovedAt" TIMESTAMP(3);
