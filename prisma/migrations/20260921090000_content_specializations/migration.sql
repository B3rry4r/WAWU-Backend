-- Specializations on a content piece (build brief C1).
--
-- The flat 25-category list is deprecated but NOT dropped here: every row
-- published before this column has a `category` and no specializations, and
-- removing it would orphan them. Both columns coexist until a backfill maps
-- the old categories onto the new taxonomy.
--
-- Additive and defaulted, so this is safe on a live table: existing rows get
-- an empty array rather than NULL, and nothing has to be written before the
-- deploy that starts reading it.

ALTER TABLE "ContentPiece"
  ADD COLUMN IF NOT EXISTS "specializations" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Buyers filter by specialization, so the read path is "find every piece
-- carrying this id". GIN is the index for a containment query on an array;
-- a btree here would be useless for @> and never chosen by the planner.
CREATE INDEX IF NOT EXISTS "ContentPiece_specializations_idx"
  ON "ContentPiece" USING GIN ("specializations");
