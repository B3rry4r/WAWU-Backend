-- JOIN-03: only a PAID registration can be claimed.
--
-- The claim (POST /waitlist/claims) marks a registration claimed with a
-- conditional UPDATE that already requires `status = 'paid'`. This adds the
-- same rule to the table itself, so no later code path, and no hand-written
-- UPDATE, can leave a `pending` row or a `failed` row (a second payment kept
-- for a refund) with an owner: a claimed row is a paid row.
--
-- Additive: one CHECK constraint on one table; no column, index or row value
-- is changed. Nothing writes `claimedByWawuId` before JOIN-03, so no existing
-- row can break it; if one ever did, adding the constraint would stop with an
-- error naming it and change nothing (one transaction).
--
-- Rollback (also in rollback.sql):
--   ALTER TABLE "WaitlistRegistration" DROP CONSTRAINT "WaitlistRegistration_claim_paid_check";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261019150000_waitlist_claim_paid';

ALTER TABLE "WaitlistRegistration"
  ADD CONSTRAINT "WaitlistRegistration_claim_paid_check"
  CHECK ("claimedByWawuId" IS NULL OR "status" = 'paid');
