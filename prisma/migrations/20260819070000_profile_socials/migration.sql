-- Creators could only link Instagram, WhatsApp and a website, which left most
-- of where their audience actually is unreachable from their profile.
ALTER TABLE "UserProfile" ADD COLUMN IF NOT EXISTS "xHandle" TEXT;
ALTER TABLE "UserProfile" ADD COLUMN IF NOT EXISTS "tiktokHandle" TEXT;
ALTER TABLE "UserProfile" ADD COLUMN IF NOT EXISTS "youtubeUrl" TEXT;
ALTER TABLE "UserProfile" ADD COLUMN IF NOT EXISTS "facebookUrl" TEXT;
ALTER TABLE "UserProfile" ADD COLUMN IF NOT EXISTS "linkedinUrl" TEXT;
