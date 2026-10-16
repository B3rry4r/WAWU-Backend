-- INBOX-07. Additive only: one index, no column, no table. The inbox ranks
-- each room by its newest message and counts the messages after a read mark,
-- both in time order inside one room.
CREATE INDEX "CommunityMessage_communityId_sentAt_idx" ON "CommunityMessage"("communityId", "sentAt");
