-- SWEEP-APP-1 (FIX-09 L1, owner rule R-5): no em-dash in anything a person can read.
--
-- Until commit 259e6c5 the paid-DM refund notice was stored as
-- 'Your N has been refunded <dash> the creator did not reply within 24 hours.'
-- FIX-09's migration (20261022130000) rewrote only ServiceApplication, so the
-- Notification rows written before it still carry the dash and the inbox shows
-- them. They are rewritten here to the wording the code now writes.
--
-- Data only. No table, column, index or constraint changes, so an older
-- instance keeps working and the web and the dashboard read the same shapes.
-- Idempotent: a second run matches no row. The dash is written as chr(8212) so
-- this file does not depend on how it is read.

UPDATE "Notification"
SET "body" = replace(
  "body",
  ' has been refunded ' || chr(8212) || ' the creator did not reply within 24 hours.',
  ' has been refunded. The creator did not reply within 24 hours.'
)
WHERE position(
  ' has been refunded ' || chr(8212) || ' the creator did not reply within 24 hours.' IN "body"
) > 0;
