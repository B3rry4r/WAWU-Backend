-- Admins had no way to remove a LIVE piece outside the pending-review flow.
-- A creator whose account was deleted before deleteAccount() started
-- removing content at deletion time (account.service.ts) can be left with
-- content stranded 'live' forever, with nobody left to reject it from
-- 'pending' since it was never pending in the first place. 'removed' records
-- that kind of decision the same way 'approved'/'rejected' record theirs.
ALTER TYPE "AdminContentDecision" ADD VALUE IF NOT EXISTS 'removed';
