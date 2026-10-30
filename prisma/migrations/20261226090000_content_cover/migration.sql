-- CONTENT-COVER (R-114, owner, 30 Oct 2026): "check for everything". A piece can carry an optional cover picture of its own.
-- Until now the Hub kept ONE public file per piece ("previewAssetUrl"), an mp4 clip for a video or a course, an mp3 or wav
-- clip for audio, a pdf extract for a pdf, so no screen could show a picture for those formats. This adds ONE nullable
-- column and nothing else: nothing the web, the dashboard or the live app calls reads it, and every existing row keeps
-- NULL (no cover), which every view serves as "no cover".
--
-- "coverKey" is the storage key of the cover (content/cover/<creator id>/<uuid>.<jpg|png|webp>), never a link: each view
-- signs a fresh link on every read. It is set and changed only by the piece's owner (POST /content, PATCH /content/:id).
--
-- Rollback: rollback.sql in this folder. It refuses while any piece has a cover, because dropping the column would leave
-- the cover files in the bucket with nothing pointing at them.

-- AlterTable
ALTER TABLE "ContentPiece" ADD COLUMN "coverKey" TEXT;
