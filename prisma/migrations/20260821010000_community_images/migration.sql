-- Communities had no image and no way to get one: `Community` was
-- (id, name, description, hostWawuId, kind), so every room rendered as a grey
-- placeholder tile, and `CommunityMessage` carried only `text`, so a member
-- could never post a photo. On a platform whose categories are fashion, food,
-- crafts, art and beauty, the photo is the point.
ALTER TABLE "Community" ADD COLUMN IF NOT EXISTS "imageUrl" TEXT;
ALTER TABLE "CommunityMessage" ADD COLUMN IF NOT EXISTS "imageUrl" TEXT;

-- An image-only message has no text, so `text` cannot stay NOT NULL. Every
-- existing row keeps its text; nothing is rewritten.
ALTER TABLE "CommunityMessage" ALTER COLUMN "text" DROP NOT NULL;

-- ...but "either half may be absent" must not become "a message with nothing
-- in it". The service rejects that with a 400; this is the same rule at the
-- table, so no other write path (a script, a seed, a future endpoint) can
-- store an empty message. Existing rows all satisfy it — `text` was NOT NULL
-- until the statement above — so the constraint validates without a backfill.
ALTER TABLE "CommunityMessage" DROP CONSTRAINT IF EXISTS "CommunityMessage_text_or_image";
ALTER TABLE "CommunityMessage"
  ADD CONSTRAINT "CommunityMessage_text_or_image"
  CHECK ("text" IS NOT NULL OR "imageUrl" IS NOT NULL);
