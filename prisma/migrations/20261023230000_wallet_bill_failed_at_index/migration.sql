-- An index for the half-hourly late-success look at failed bills (task FIX-42).
--
-- Additive only: one new index on an existing table. No column, row or other
-- index changes. The look reads "WalletBill" rows with status 'failed' and a
-- recent "failedAt", newest first; the existing index is (status,
-- purchaseSentAt), so without this one it read every failed bill each run.
--
-- Rollback: DROP INDEX "WalletBill_status_failedAt_idx";

-- CreateIndex
CREATE INDEX "WalletBill_status_failedAt_idx" ON "WalletBill"("status", "failedAt");
