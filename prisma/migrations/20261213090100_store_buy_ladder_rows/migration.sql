-- STORE-BUY-HUB (R-101): the price ladder's store products, one consumable per list price on both stores,
-- `wawu.buy.<naira>`, from 100 to 1,000,000 naira (the 25 list prices of `prices.list_naira`, R-101 point 1).
-- `referenceKobo` is the list price; `storePriceKobo` is what each store charges in Nigeria on the 15% ladder (the
-- list price plus the store's cut and VAT, rounded up to the store's next price step, R-101 point 2).
-- Admin-editable like every other row (`admin/store/products`). Safe to run again: a row that already exists (an
-- admin made it first) is left as it is. Rollback: rollback.sql (removes the ladder rows no purchase uses).
--
-- The same figures are in src/store/store-ladder.ts; a spec checks the two agree.

INSERT INTO "StoreProduct" ("id", "platform", "storeProductId", "kind", "title", "grants", "referenceKobo", "storePriceKobo", "active", "sortOrder", "updatedAt")
SELECT gen_random_uuid()::text, p."platform", 'wawu.buy.' || l."naira", 'buy', 'Buy at ' || l."naira" || ' naira',
       '{"packId":null,"pack":null,"tierId":null,"days":null}'::jsonb, l."naira" * 100, l."store" * 100, true,
       l."position", CURRENT_TIMESTAMP
  FROM (VALUES
    (100, 130, 1),
    (200, 260, 2),
    (500, 650, 3),
    (1000, 1300, 4),
    (1500, 1900, 5),
    (2000, 2550, 6),
    (2500, 3200, 7),
    (3000, 3800, 8),
    (4000, 5100, 9),
    (5000, 6400, 10),
    (7500, 9500, 11),
    (10000, 12700, 12),
    (15000, 19000, 13),
    (20000, 25300, 14),
    (25000, 31900, 15),
    (30000, 38000, 16),
    (40000, 50900, 17),
    (50000, 63500, 18),
    (75000, 94900, 19),
    (100000, 126900, 20),
    (150000, 189900, 21),
    (200000, 254900, 22),
    (250000, 319000, 23),
    (500000, 649000, 24),
    (1000000, 1299000, 25)
  ) AS l("naira", "store", "position")
  CROSS JOIN (VALUES ('android'::"StorePlatform"), ('ios'::"StorePlatform")) AS p("platform")
ON CONFLICT ("platform", "storeProductId") DO NOTHING;
