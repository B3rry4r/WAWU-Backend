-- Both ticks drop to NGN 2,000 a year.
--
-- Product owner, 21 Sep 2026: "reduce both prices of the verifications to
-- 2000 naira for each". They were 4,999 (creator) and 9,999 (professional).
--
-- TWO CHANGES, AND THE SECOND ONE IS THE POINT.
--
-- Changing the column DEFAULT only affects rows inserted from here on. The
-- settings row already exists in production and would have kept its 4,999 and
-- 9,999 forever, so the price on the live site would not have moved at all
-- and this would have looked done while changing nothing. The UPDATE is what
-- actually reprices the product.
--
-- The UPDATE is unconditional rather than "only where it still equals the old
-- price". PlatformSettings has no writer anywhere in this codebase yet: the
-- dashboard surface for it was specified and never built, so every value
-- stored in that table today came from the column default. There is no
-- deliberately-set figure here to protect. If a dashboard writer is ever
-- added, this reasoning stops holding and a future repricing should be done
-- from that surface rather than from a migration.
--
-- Safe to re-run: setting a column to a literal is idempotent.

ALTER TABLE "PlatformSettings"
  ALTER COLUMN "creatorVerificationPriceNgn" SET DEFAULT 2000,
  ALTER COLUMN "professionalVerificationPriceNgn" SET DEFAULT 2000;

UPDATE "PlatformSettings"
   SET "creatorVerificationPriceNgn" = 2000,
       "professionalVerificationPriceNgn" = 2000;
