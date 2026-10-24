-- FIX-105 round 2 (R-81, verifier finding H1). A room whose notices could not be written in a pass is listed here
-- and tried again later, so one failing room never holds the sweep's cursor for every other room. Additive only:
-- one new table. Nothing the web or the dashboard calls reads or writes it.
CREATE TABLE "CommunityNoticeRetry" (
    "communityId" TEXT NOT NULL,
    "fromAt" TIMESTAMP(3) NOT NULL,
    "retryAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "CommunityNoticeRetry_pkey" PRIMARY KEY ("communityId")
);
