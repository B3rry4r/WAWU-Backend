-- Private communities were a dead end: POST /communities/:id/join wrote
-- `status = 'pending'` and nothing in the codebase ever flipped it to
-- 'joined', so CommunityMessage.assertMember (which requires 'joined')
-- locked every requester out of the room forever. The host-side review
-- endpoints (GET /communities/:id/requests, approve, decline) fix that.
--
-- This migration adds the one thing those endpoints could not be built
-- honestly without: a timestamp on the REQUEST.
--
-- `joinedAt` stays null for a pending row, so a pending membership carried
-- no time information whatsoever — a review queue could only have been
-- ordered by its random uuid `id`, which is stable but meaningless. FIFO is
-- the whole point of a queue, and the host is paying for this feature.
--
-- NOTE what this migration deliberately does NOT do: it does not add a
-- `declined` value to MembershipStatus. Declining DELETES the pending row —
-- the same thing `DELETE /communities/:id/join` (leave) already does — so
-- absence keeps meaning exactly one thing ("not a member, not waiting")
-- everywhere in this schema, and a decline stays a decision about one
-- request rather than a permanent block list this product has never
-- specified. See CommunityService.declineJoinRequest for the full reasoning.

ALTER TABLE "CommunityMembership"
  ADD COLUMN IF NOT EXISTS "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Truthful backfill for rows that predate the column: someone who is already
-- `joined` requested no later than the moment they joined, so `joinedAt` is
-- the best real answer available. Rows with no `joinedAt` (pending ones) keep
-- the DEFAULT — there is no earlier timestamp anywhere to recover.
UPDATE "CommunityMembership"
SET "requestedAt" = "joinedAt"
WHERE "joinedAt" IS NOT NULL;

-- The queue reads `where communityId = ? and status = 'pending'`.
CREATE INDEX IF NOT EXISTS "CommunityMembership_communityId_status_idx"
  ON "CommunityMembership"("communityId", "status");
