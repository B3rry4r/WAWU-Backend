-- FIX-105 (R-81). A person is told when a community they joined has new messages: one grouped notice per person and
-- community, counted from a short sweep over the messages sent. Additive only: two new tables and one index.
-- Nothing the web or the dashboard calls reads or writes them.

-- The sweep reads the messages of one time window across all rooms.
CREATE INDEX "CommunityMessage_sentAt_idx" ON "CommunityMessage"("sentAt");

-- The count behind one grouped notice (one row per notice; the notice is open while its Notification is unread).
CREATE TABLE "CommunityMessageNotice" (
    "notificationId" TEXT NOT NULL,
    "userWawuId" TEXT NOT NULL,
    "communityId" TEXT NOT NULL,
    "messageCount" INTEGER NOT NULL,
    "lastMessageAt" TIMESTAMP(3) NOT NULL,
    "countedUpTo" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommunityMessageNotice_pkey" PRIMARY KEY ("notificationId")
);

CREATE INDEX "CommunityMessageNotice_userWawuId_communityId_idx" ON "CommunityMessageNotice"("userWawuId", "communityId");

ALTER TABLE "CommunityMessageNotice" ADD CONSTRAINT "CommunityMessageNotice_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- How far the sweep has read, and which Hub instance is working on it. No row until the first sweep runs, which
-- starts from "now": messages sent before this build never become notices.
CREATE TABLE "CommunityNoticeCursor" (
    "id" INTEGER NOT NULL,
    "countedUpTo" TIMESTAMP(3) NOT NULL,
    "leaseUntil" TIMESTAMP(3),

    CONSTRAINT "CommunityNoticeCursor_pkey" PRIMARY KEY ("id")
);
