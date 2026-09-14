-- Flutterwave's bill-payment endpoint confirms the request was ACCEPTED, not
-- that the biller delivered it: delivery is asynchronous and must be
-- confirmed separately (GET /v3/bills/{reference}?verbose=1 or a webhook).
-- The service used to record any non-throwing response as 'delivered'
-- immediately, so a customer could be charged, see a "delivered" receipt,
-- and never receive the airtime/bill if the async step later failed, with
-- nothing anywhere set up to catch it. 'processing' is the honest state in
-- between: the request was accepted, delivery is still unconfirmed.
ALTER TYPE "FulfilmentStatus" ADD VALUE IF NOT EXISTS 'processing' AFTER 'paid';
