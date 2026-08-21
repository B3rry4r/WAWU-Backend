-- CreatorSubscriptionService.verify() upserted CreatorSubscription and
-- CreatorState (subscriptionPaid = true) but never wrote
-- UserProfile.accountType. Every CreatorAccountGuard in the codebase
-- (creator-earnings, creator-subscription, content-piece, direct-message,
-- creator-no-response-tracker) gates on `profile.accountType !== 'creator'`,
-- so a creator who had genuinely paid was 403'd out of Earnings, Subscription
-- management, uploads and paid DMs. verify() now promotes the account inside
-- the same transaction; this backfills everyone who paid before that change.
--
-- PROMOTION ONLY. Nothing here demotes: per CLAUDE.md creator is an ACCOUNT
-- TYPE, not an earned tier, so a lapsed subscription must never flip an
-- account back to 'user'.
--
-- Idempotent by construction: the UPDATE is a no-op once accountType is
-- already 'creator', and the INSERT is ON CONFLICT DO NOTHING.

-- ---------------------------------------------------------------------------
-- 1. Promote existing profiles.
--
--    Two populations, both of which paid:
--      a) CreatorState.subscriptionPaid = true  — currently entitled.
--      b) any CreatorSubscription row at all    — paid at some point. The
--         hourly `expire-subscriptions` job clears subscriptionPaid when a
--         subscription goes past_due/expired, so restricting to (a) alone
--         would leave a creator whose card lapsed still locked out of the
--         very screens they need to fix it (retry-payment, billing). Their
--         upload gate stays closed either way — that gate is
--         subscriptionPaid, which this migration does not touch.
-- ---------------------------------------------------------------------------

UPDATE "UserProfile" p
SET "accountType" = 'creator'
WHERE p."accountType" IS DISTINCT FROM 'creator'
  AND (
    EXISTS (
      SELECT 1 FROM "CreatorState" cs
      WHERE cs."wawuUserId" = p."wawuUserId" AND cs."subscriptionPaid" = true
    )
    OR EXISTS (
      SELECT 1 FROM "CreatorSubscription" s
      WHERE s."creatorWawuId" = p."wawuUserId"
    )
  );

-- ---------------------------------------------------------------------------
-- 2. Create a profile for a payer who has none.
--
--    UserProfile is written on the first PATCH /users/me, which a subscriber
--    who signed up and paid without finishing onboarding may never have hit —
--    and the guards treat a missing row exactly like a non-creator one. Only
--    the two required columns are set: `accountType`, and `interests` (a
--    NOT NULL String[]). Everything else is nullable and is left for the
--    profile screen to fill in. `createdAt` takes its schema default.
-- ---------------------------------------------------------------------------

INSERT INTO "UserProfile" ("wawuUserId", "accountType", "interests")
SELECT u."wawuUserId", 'creator', ARRAY[]::text[]
FROM (
  SELECT cs."wawuUserId" FROM "CreatorState" cs WHERE cs."subscriptionPaid" = true
  UNION
  SELECT s."creatorWawuId" FROM "CreatorSubscription" s
) u
WHERE NOT EXISTS (
  SELECT 1 FROM "UserProfile" p WHERE p."wawuUserId" = u."wawuUserId"
)
ON CONFLICT ("wawuUserId") DO NOTHING;
