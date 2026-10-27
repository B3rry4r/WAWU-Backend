-- PRICE-LIST (R-101, owner, 27 Oct 2026): every price a person sets comes from the price list. This moves the prices already
-- set that are not on it to the nearest list price (the lower one on a tie; a price above the top moves to the top).
--
-- Additive: one new table, "PriceListMove", the audit of every move (kind, item, owner, old price, new price, whether the owner was
-- told). No column, index or constraint of an existing table changes. Rows are only updated in their price: a paid piece
-- (any status but removed), a creator's paid-message price, a private room's monthly pass price, and a ticket type of an event
-- that is not removed or called off, when nothing has sold on it (R-40: a price locks once a ticket sells; a retired tier is left).
-- A free piece, a free ticket and a price already on the list are not touched. Drafts are not touched.
--
-- The list is the saved admin setting 'prices.list_naira' if a row exists, else the launch list of R-101. The owner is told once
-- per item by PriceMoveNoticeService, which finds the rows here with "notifiedAt" empty.
--
-- Safe to run again: only prices not on the list are selected, and after a run none are. Rollback: rollback.sql (puts every
-- old price back, and refuses while any moved price has been changed since).

CREATE TABLE "PriceListMove" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "ownerWawuId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "oldPriceKobo" BIGINT NOT NULL,
    "newPriceKobo" BIGINT NOT NULL,
    "movedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notifiedAt" TIMESTAMP(3),

    CONSTRAINT "PriceListMove_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PriceListMove_kind_subjectId_idx" ON "PriceListMove"("kind", "subjectId");
CREATE INDEX "PriceListMove_ownerWawuId_idx" ON "PriceListMove"("ownerWawuId");

-- The list price (whole naira) nearest to p, a price in KOBO, compared in kobo so a pass of 175,049 kobo is judged as it is and
-- not rounded to naira first: the lower on an exact midpoint, the top for a price above it, the bottom for one below it.
CREATE FUNCTION pg_temp.price_list_nearest(p bigint, list integer[]) RETURNS integer AS $$
  SELECT CASE
    WHEN lo IS NULL THEN hi
    WHEN hi IS NULL THEN lo
    WHEN p - lo::bigint * 100 <= hi::bigint * 100 - p THEN lo
    ELSE hi
  END
  FROM (
    SELECT (SELECT max(l) FROM unnest(list) AS l WHERE l::bigint * 100 <= p) AS lo,
           (SELECT min(l) FROM unnest(list) AS l WHERE l::bigint * 100 >= p) AS hi
  ) AS around
$$ LANGUAGE sql IMMUTABLE;

DO $$
DECLARE
  list integer[];
BEGIN
  SELECT array_agg(x::integer ORDER BY x::integer) INTO list
    FROM (SELECT jsonb_array_elements_text("value") AS x FROM "PlanSetting" WHERE "key" = 'prices.list_naira') AS s;
  IF list IS NULL OR array_length(list, 1) IS NULL THEN
    list := ARRAY[100, 200, 500, 1000, 1500, 2000, 2500, 3000, 4000, 5000, 7500, 10000, 15000, 20000, 25000, 30000, 40000,
                  50000, 75000, 100000, 150000, 200000, 250000, 500000, 1000000];
  END IF;

  -- Paid pieces.
  WITH off AS (
    SELECT "id", "creatorWawuId", "title", "price", pg_temp.price_list_nearest("price"::bigint * 100, list) AS np
      FROM "ContentPiece"
     WHERE "accessType" = 'paid' AND "price" > 0 AND "status" <> 'removed' AND NOT ("price" = ANY (list))
       FOR UPDATE
  ), logged AS (
    INSERT INTO "PriceListMove" ("id", "kind", "subjectId", "ownerWawuId", "title", "oldPriceKobo", "newPriceKobo")
    SELECT gen_random_uuid()::text, 'content', "id", "creatorWawuId", "title", "price"::bigint * 100, np::bigint * 100 FROM off
  )
  UPDATE "ContentPiece" c SET "price" = off.np FROM off WHERE c."id" = off."id";

  -- Paid messages: the creator's price for one question.
  WITH off AS (
    SELECT "wawuUserId", "dmPrice", pg_temp.price_list_nearest("dmPrice"::bigint * 100, list) AS np
      FROM "CreatorState"
     WHERE "dmPrice" IS NOT NULL AND "dmPrice" > 0 AND NOT ("dmPrice" = ANY (list))
       FOR UPDATE
  ), logged AS (
    INSERT INTO "PriceListMove" ("id", "kind", "subjectId", "ownerWawuId", "title", "oldPriceKobo", "newPriceKobo")
    SELECT gen_random_uuid()::text, 'paid_dm', "wawuUserId", "wawuUserId", 'paid messages', "dmPrice"::bigint * 100, np::bigint * 100 FROM off
  )
  UPDATE "CreatorState" s SET "dmPrice" = off.np FROM off WHERE s."wawuUserId" = off."wawuUserId";

  -- A private room's monthly pass. A price in kobo that is not whole naira is not on the list either.
  WITH off AS (
    SELECT p."communityId", c."hostWawuId", c."name", p."priceKobo",
           pg_temp.price_list_nearest(p."priceKobo", list) AS np
      FROM "CommunityPassPrice" p JOIN "Community" c ON c."id" = p."communityId"
     WHERE p."priceKobo" > 0 AND (p."priceKobo" % 100 <> 0 OR NOT ((p."priceKobo" / 100)::integer = ANY (list)))
       FOR UPDATE OF p
  ), logged AS (
    INSERT INTO "PriceListMove" ("id", "kind", "subjectId", "ownerWawuId", "title", "oldPriceKobo", "newPriceKobo")
    SELECT gen_random_uuid()::text, 'community_pass', "communityId", "hostWawuId", "name", "priceKobo", np::bigint * 100 FROM off
  )
  UPDATE "CommunityPassPrice" p SET "priceKobo" = off.np::bigint * 100 FROM off WHERE p."communityId" = off."communityId";

  -- Ticket types nothing has sold on.
  WITH off AS (
    SELECT t."id", e."hostWawuId", t."name" || ' at ' || e."name" AS label, t."priceNaira",
           pg_temp.price_list_nearest(t."priceNaira"::bigint * 100, list) AS np
      FROM "EventTicketType" t JOIN "Event" e ON e."id" = t."eventId"
     WHERE t."priceNaira" > 0 AND t."sold" = 0 AND t."retiredAt" IS NULL
       AND e."status" NOT IN ('removed', 'cancelled') AND NOT (t."priceNaira" = ANY (list))
       FOR UPDATE OF t
  ), logged AS (
    INSERT INTO "PriceListMove" ("id", "kind", "subjectId", "ownerWawuId", "title", "oldPriceKobo", "newPriceKobo")
    SELECT gen_random_uuid()::text, 'ticket_type', "id", "hostWawuId", label, "priceNaira"::bigint * 100, np::bigint * 100 FROM off
  )
  UPDATE "EventTicketType" t SET "priceNaira" = off.np FROM off WHERE t."id" = off."id";
END $$;
