\set ON_ERROR_STOP on
-- Rollback of 20261212090000_price_list (PRICE-LIST, R-101). Run with: psql -1 -f rollback.sql
-- Puts every price the migration moved back to what it was, from "PriceListMove", then drops that table.
-- It REFUSES, and changes nothing, while any moved item now holds a price that is neither the one the migration set nor
-- the one it replaced (a person changed it since: restoring would overwrite their choice) - and while a ticket type it
-- moved has since sold (its price is locked). Those items are listed in the error. Decide each by hand first (set the
-- price you want, or delete that item's row from "PriceListMove" to leave it alone), then run this again.
-- Notifications already sent stay: they are history.
DO $$
DECLARE
  changed integer;
BEGIN
  SELECT count(*) INTO changed FROM "PriceListMove" m
   WHERE (m."kind" = 'content' AND EXISTS (
            SELECT 1 FROM "ContentPiece" c WHERE c."id" = m."subjectId"
               AND c."price"::bigint * 100 NOT IN (m."newPriceKobo", m."oldPriceKobo")))
      OR (m."kind" = 'paid_dm' AND EXISTS (
            SELECT 1 FROM "CreatorState" s WHERE s."wawuUserId" = m."subjectId"
               AND s."dmPrice"::bigint * 100 NOT IN (m."newPriceKobo", m."oldPriceKobo")))
      OR (m."kind" = 'community_pass' AND EXISTS (
            SELECT 1 FROM "CommunityPassPrice" p WHERE p."communityId" = m."subjectId"
               AND p."priceKobo" NOT IN (m."newPriceKobo", m."oldPriceKobo")))
      OR (m."kind" = 'ticket_type' AND EXISTS (
            SELECT 1 FROM "EventTicketType" t WHERE t."id" = m."subjectId"
               AND (t."priceNaira"::bigint * 100 NOT IN (m."newPriceKobo", m."oldPriceKobo")
                    OR (t."sold" > 0 AND t."priceNaira"::bigint * 100 = m."newPriceKobo"))));
  IF changed > 0 THEN
    RAISE EXCEPTION 'PRICE-LIST rollback: % moved price(s) were changed or locked since the migration. Nothing was changed.', changed;
  END IF;
END $$;

UPDATE "ContentPiece" c SET "price" = (m."oldPriceKobo" / 100)::integer
  FROM "PriceListMove" m WHERE m."kind" = 'content' AND m."subjectId" = c."id" AND c."price"::bigint * 100 = m."newPriceKobo";
UPDATE "CreatorState" s SET "dmPrice" = (m."oldPriceKobo" / 100)::integer
  FROM "PriceListMove" m WHERE m."kind" = 'paid_dm' AND m."subjectId" = s."wawuUserId" AND s."dmPrice"::bigint * 100 = m."newPriceKobo";
UPDATE "CommunityPassPrice" p SET "priceKobo" = m."oldPriceKobo"
  FROM "PriceListMove" m WHERE m."kind" = 'community_pass' AND m."subjectId" = p."communityId" AND p."priceKobo" = m."newPriceKobo";
UPDATE "EventTicketType" t SET "priceNaira" = (m."oldPriceKobo" / 100)::integer
  FROM "PriceListMove" m WHERE m."kind" = 'ticket_type' AND m."subjectId" = t."id" AND t."priceNaira"::bigint * 100 = m."newPriceKobo" AND t."sold" = 0;

DROP TABLE "PriceListMove";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261212090000_price_list';
