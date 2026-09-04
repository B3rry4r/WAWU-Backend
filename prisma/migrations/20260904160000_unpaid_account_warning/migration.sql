-- When the single "your unpaid creator account closes soon" email was sent.
-- Nullable, and null means "not warned yet", which the reaper treats as
-- never-deletable: an account nobody has been able to contact must not be
-- removed on a clock it was never told about.
ALTER TABLE "UserProfile" ADD COLUMN "unpaidWarnedAt" TIMESTAMP(3);
