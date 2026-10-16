-- SETTINGS-06 round 7: the hourly pass claims the rows it works on.
--
-- Additive: one nullable column, nothing else. No row is touched.
--   reconcileClaimedUntil  null: never claimed. In the future: a pass (this
--             server's or another's) holds the row until then, so two servers
--             running the pass at once do not ask the provider about the same
--             wallet twice. In the past: when the last pass finished with the
--             row (or the lease ran out after a crash). The pass takes the
--             rows checked longest ago first, so a cap or a time budget never
--             starves the same rows hour after hour.
--
-- Rollback (also in rollback.sql): drops the column.

ALTER TABLE "AccountDeletion" ADD COLUMN "reconcileClaimedUntil" TIMESTAMP(3);
