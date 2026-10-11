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
-- a release with nothing to move sets both in one update).
--
-- All or nothing (round 3, R2-3): the DROP and the ADD are ONE transaction
-- (BEGIN and COMMIT below). If a row did not pass, ADD CONSTRAINT refuses
-- (SQLSTATE 23514) and the transaction rolls back, so the table keeps the old
-- CHECK exactly as it was, and the migration can be run again once the row is
-- put right (`prisma migrate resolve --rolled-back` first, since Prisma marks
-- the failed run). Without the transaction the DROP would have been
-- committed and the table left with no outcome CHECK at all.
--
-- Folder renamed from 20261020190000 to 20261021080000 so it sorts after
-- 20261021010000_community_message_key (backend main); it was never deployed.
--
-- Rollback: recreate "WalletHold_outcome_check" as 20261020160000 defines it.

BEGIN;

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

COMMIT;
