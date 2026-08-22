-- Three states a paying customer could enter and never leave.
--
-- 1. FulfilmentStatus.refunded had no writer at all on BillPayment or
--    HealthSubscription, while the failure copy the customer sees says
--    verbatim "our team will refund you". Nothing in this codebase can move
--    money back to a card (no Flutterwave refund adapter exists), so the
--    operator endpoint that sets `refunded` has to record the reference of a
--    refund a human actually made. These columns are that record; without one
--    the status is a lie, so the endpoint refuses to write it.
--
-- 2. A legal request could reach `in_progress` — fully paid — and never leave.
--    Cancelling is now possible, and a cancellation with no stated reason is
--    exactly the dead end being fixed, so the reason is stored beside it.
--
-- Additive only: every column is nullable and every existing row keeps its
-- current meaning.
ALTER TABLE "BillPayment" ADD COLUMN IF NOT EXISTS "refundReference" TEXT;
ALTER TABLE "BillPayment" ADD COLUMN IF NOT EXISTS "refundedAt" TIMESTAMP(3);

ALTER TABLE "HealthSubscription" ADD COLUMN IF NOT EXISTS "refundReference" TEXT;
ALTER TABLE "HealthSubscription" ADD COLUMN IF NOT EXISTS "refundedAt" TIMESTAMP(3);

ALTER TABLE "LegalRequest" ADD COLUMN IF NOT EXISTS "cancellationReason" TEXT;
ALTER TABLE "LegalRequest" ADD COLUMN IF NOT EXISTS "cancelledAt" TIMESTAMP(3);
