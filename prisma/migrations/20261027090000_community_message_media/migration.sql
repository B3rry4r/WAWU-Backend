-- INBOX-22 (R-62): a community message can carry a video or a voice note.
--
-- Two nullable columns on "CommunityMessage", beside "imageUrl": "videoUrl" and
-- "voiceUrl". No default, no backfill: every message already stored keeps null in
-- both and reads exactly as before. The charge by kind (text free, a photo 1, a
-- video or voice note 3) is the service's, from admin settings; nothing in this
-- file prices anything.
--
-- Two CHECKs, because the service enforces both and a table should not depend on
-- the one writer being careful:
--   * "CommunityMessage_text_or_image" (kept under its name) now also counts a
--     video or a voice note, so a message with only one of those is not empty.
--   * "CommunityMessage_one_attachment": at most one of the three attachments.
--     A message therefore costs one kind's price, never a sum nobody ruled on.
-- Every row already stored satisfies both (it has text or an image, and no video
-- or voice note), so they validate without a backfill.
--
-- Additive for the web and the dashboard: they read the message as a row spread
-- and now see two more keys, both null for what they already show.
--
-- Rollback (no message with a video or a voice note may exist first; export them,
-- the files stay in storage):
--   ALTER TABLE "CommunityMessage" DROP CONSTRAINT "CommunityMessage_one_attachment";
--   ALTER TABLE "CommunityMessage" DROP CONSTRAINT "CommunityMessage_text_or_image";
--   ALTER TABLE "CommunityMessage" ADD CONSTRAINT "CommunityMessage_text_or_image"
--     CHECK ("text" IS NOT NULL OR "imageUrl" IS NOT NULL);
--   ALTER TABLE "CommunityMessage" DROP COLUMN "voiceUrl", DROP COLUMN "videoUrl";

ALTER TABLE "CommunityMessage" ADD COLUMN "videoUrl" TEXT;
ALTER TABLE "CommunityMessage" ADD COLUMN "voiceUrl" TEXT;

ALTER TABLE "CommunityMessage" DROP CONSTRAINT IF EXISTS "CommunityMessage_text_or_image";
ALTER TABLE "CommunityMessage"
  ADD CONSTRAINT "CommunityMessage_text_or_image"
  CHECK ("text" IS NOT NULL OR "imageUrl" IS NOT NULL OR "videoUrl" IS NOT NULL OR "voiceUrl" IS NOT NULL);

ALTER TABLE "CommunityMessage"
  ADD CONSTRAINT "CommunityMessage_one_attachment"
  CHECK (num_nonnulls("imageUrl", "videoUrl", "voiceUrl") <= 1);
