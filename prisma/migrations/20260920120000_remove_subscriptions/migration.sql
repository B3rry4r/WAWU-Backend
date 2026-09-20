-- Remove subscriptions.
--
-- Build brief B1: "There is no subscription tier. Registration, profile
-- creation and listing are free ... Remove all subscription UI. Do not gate
-- uploads behind payment."
--
-- SAFETY: this drops tables, so it was checked against production before
-- being written rather than assumed. GET /admin/payments/receipts on the live
-- API returns total: 0 — no charge has ever succeeded, so there is no
-- subscriber, no billing history and no money in flight to preserve. If that
-- had come back non-zero this would have been an expand/contract pair (stop
-- writing, deploy, verify, then drop) instead of a single migration.
--
-- ReferralCode / ReferralRedemption / ReferralClaim go too. They are not
-- collateral tidying: a referral code was a percentage off ONE subscription
-- plan, keyed to CreatorTier and priced from the plan table, so with no plan
-- there is nothing for a percentage to apply to. Re-pointing codes at
-- verification fees is the obvious successor and is a product decision, not
-- one to make inside a migration.

-- Drop dependants before their parents so no FK is left dangling.
DROP TABLE IF EXISTS "ReferralRedemption";
DROP TABLE IF EXISTS "ReferralClaim";
DROP TABLE IF EXISTS "ReferralCode";
DROP TABLE IF EXISTS "CreatorSubscription";

-- CreatorState keeps kycStatus: KYC gates EARNING and is untouched. Only the
-- payment gate and the plan it pointed at are removed.
DROP INDEX IF EXISTS "CreatorState_tier_idx";
ALTER TABLE "CreatorState" DROP COLUMN IF EXISTS "tier";
ALTER TABLE "CreatorState" DROP COLUMN IF EXISTS "subscriptionPaid";

-- Enums last: nothing references them once the columns above are gone.
DROP TYPE IF EXISTS "SubscriptionStatus";
DROP TYPE IF EXISTS "CreatorTier";
