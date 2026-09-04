-- A profile picture and a cover image. Neither existed, so a creator's avatar
-- was always a generated initial and there was nothing to upload into.
ALTER TABLE "UserProfile" ADD COLUMN "avatarUrl" TEXT;
ALTER TABLE "UserProfile" ADD COLUMN "coverUrl" TEXT;
