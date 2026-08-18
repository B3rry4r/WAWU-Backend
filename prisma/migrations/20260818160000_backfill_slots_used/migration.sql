-- CreatorState.slotsUsed was never incremented: ContentPieceService.create()
-- wrote the ContentPiece but left the counter at its default of 0, so every
-- creator read back "0 of 3 slots used" no matter how much they had published,
-- and nothing capped uploads at the tier allowance.
--
-- create() now claims a slot inside the same transaction as the insert. This
-- backfills the counter for rows written before that change so the cap starts
-- from the truth rather than from 0. Idempotent: re-running recomputes the
-- same value from ContentPiece.

UPDATE "CreatorState" cs
SET "slotsUsed" = COALESCE(c.n, 0)
FROM (
  SELECT "creatorWawuId", COUNT(*)::int AS n
  FROM "ContentPiece"
  GROUP BY "creatorWawuId"
) c
WHERE c."creatorWawuId" = cs."wawuUserId"
  AND cs."slotsUsed" IS DISTINCT FROM COALESCE(c.n, 0);
