-- MOD-ROOMS (R-122; store review: Apple guideline 1.2, Google Play's user-generated content policy). A room's host can
-- delete any message in their room and mute a member. Additive only: TWO new tables, no existing table or column changes.
-- Nothing the web, the dashboard or the live app calls reads them; a room with no row here answers exactly as before.
--
-- "CommunityMute": one row per room and member. The member still reads the room; sending is refused. Unmuting deletes
-- the row. The unique pair makes a second mute of the same member a no-op, never a second row.
-- "CommunityModerationLog": who did what in a room and when (message_deleted, member_muted, member_unmuted). It has no
-- foreign key to the room on purpose, so the record outlives the room; it keeps the message's id, kind and writer, not
-- its words.
--
-- Rollback: rollback.sql in this folder. It REFUSES while either table holds a row (a mute still in force would be
-- silently lifted, and the log is a record), and says which. Run with: psql -1 -f rollback.sql

-- CreateTable
CREATE TABLE "CommunityMute" (
    "id" TEXT NOT NULL,
    "communityId" TEXT NOT NULL,
    "userWawuId" TEXT NOT NULL,
    "mutedByWawuId" TEXT NOT NULL,
    "mutedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommunityMute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunityModerationLog" (
    "id" TEXT NOT NULL,
    "communityId" TEXT NOT NULL,
    "actorWawuId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetWawuId" TEXT,
    "messageId" TEXT,
    "messageKind" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommunityModerationLog_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CommunityModerationLog_action_check" CHECK ("action" IN ('message_deleted', 'member_muted', 'member_unmuted')),
    CONSTRAINT "CommunityModerationLog_message_check" CHECK ("messageKind" IS NULL OR "messageKind" IN ('text', 'photo', 'video', 'voice'))
);

-- CreateIndex
CREATE UNIQUE INDEX "CommunityMute_communityId_userWawuId_key" ON "CommunityMute"("communityId", "userWawuId");

-- CreateIndex
CREATE INDEX "CommunityMute_userWawuId_idx" ON "CommunityMute"("userWawuId");

-- CreateIndex
CREATE INDEX "CommunityModerationLog_communityId_createdAt_idx" ON "CommunityModerationLog"("communityId", "createdAt");

-- CreateIndex
CREATE INDEX "CommunityModerationLog_actorWawuId_idx" ON "CommunityModerationLog"("actorWawuId");

-- AddForeignKey
ALTER TABLE "CommunityMute" ADD CONSTRAINT "CommunityMute_communityId_fkey" FOREIGN KEY ("communityId") REFERENCES "Community"("id") ON DELETE CASCADE ON UPDATE CASCADE;
