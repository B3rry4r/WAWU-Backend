-- Scheduled tier change for creator subscriptions (additive, nullable).
--
-- A downgrade is scheduled, not immediate: the annual term is already paid
-- for and no refund is given, so Pro entitlements are honoured until
-- `currentPeriodEnd`. `pendingTier` is the tier the subscription moves to,
-- `tierChangesAt` is when. Both NULL = nothing scheduled, which is the state
-- every existing row is already in.
ALTER TABLE "CreatorSubscription" ADD COLUMN "pendingTier" "CreatorTier";
ALTER TABLE "CreatorSubscription" ADD COLUMN "tierChangesAt" TIMESTAMP(3);

CREATE INDEX "CreatorSubscription_tierChangesAt_idx" ON "CreatorSubscription"("tierChangesAt");
