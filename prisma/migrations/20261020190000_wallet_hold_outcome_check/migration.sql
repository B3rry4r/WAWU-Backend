-- MONEY-18 round 2, F3: a settled hold must name its action.
--
-- "WalletHold_outcome_check" (20261020160000_wallet_holds) was
--   status = 'held'
--   OR (status = 'released' AND action = 'release' AND ...)
--   OR (status = 'refunded' AND action = 'refund' AND refundedKobo = amountKobo)
-- With "action" NULL the second and third arms are NULL, not false, and a
-- CHECK passes on NULL, so Postgres accepted
--   UPDATE "WalletHold" SET status = 'released', "settledAt" = now()
--    WHERE action IS NULL
-- (and the refunded form). The same hole sat in the refund arm when
-- "refundedKobo" was NULL. The service never writes either, but the table
-- says the database holds the rules whatever the code does, so it does now:
-- each non-held arm states that the action (and, for a refund, the refunded
-- amount) is present, so a NULL makes the arm false, not unknown.
--
-- Nothing is added, renamed or retyped: one CHECK is dropped and recreated
-- with the same name. Existing rows pass it (a settled hold has always been
-- written with its action: the service sets the action before it settles, and
-- a release with nothing to move sets both in one update). If one did not,
-- the ADD CONSTRAINT would refuse and name it, and nothing would change.
--
-- Rollback: recreate "WalletHold_outcome_check" as 20261020160000 defines it.

ALTER TABLE "WalletHold" DROP CONSTRAINT "WalletHold_outcome_check";
ALTER TABLE "WalletHold" ADD CONSTRAINT "WalletHold_outcome_check"
    CHECK (
      ("status" = 'held')
      OR ("status" = 'released'
          AND "action" IS NOT NULL AND "action" = 'release'
          AND "refundedKobo" IS NULL)
      OR ("status" = 'refunded'
          AND "action" IS NOT NULL AND "action" = 'refund'
          AND "refundedKobo" IS NOT NULL AND "refundedKobo" = "amountKobo")
    );
