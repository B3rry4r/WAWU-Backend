-- STORE-SEED (owner, 30 Oct 2026): the store products that sell tiers, points, credits and the upload pack, which
-- nothing ever inserted. `GET /store/products` lists only the `StoreProduct` rows (only the price ladder of
-- 20261213090100_store_buy_ladder_rows existed), so the app drew "No tiers on sale" and "Buying is not open yet".
-- The products exist and are active in both stores (Google Play, package africa.wawu.wmt; App Store, app 6827108525),
-- under the same ids on both. One row per product per platform (10 products, 20 rows), `active`.
--
-- `grants` is what ONE purchase gives, in the stored shape `checkProduct` writes (src/store/store-grants.ts), taken from
-- the plan (src/plans/plans.config.json) and matched to each store id by its price:
--   wawu.points.s / .m / .l         points pack s / m / l (price 1,000 / 2,500 / 5,000 naira)   {"packId": "s" | "m" | "l"}
--   wawu.credits.starter/popular/pro credits pack (price 500 / 1,000 / 2,000 naira)             {"pack": "starter" | "popular" | "pro"}
--   wawu.tier.verify/plus/founding  tier verify / plus / founding (2,999 / 5,999 / 9,999 naira, 365 days)  {"tierId": "verify" | "plus" | "founding"}
--   wawu.more.products.5            upload pack of 5 (price 1,500 naira; the plan's count)       {"extraProducts": 5}
-- `referenceKobo` as the admin route writes it: null for points, tiers and the upload pack (WAWU's own sale, no creator is
-- paid); a credits pack's wallet price (PACK_TABLE: 500 / 1,000 / 2,000 naira, in kobo). Points, credits and tiers store
-- the plan entry's id, so the count each gives is read from the live plan; the upload pack stores its count as a number
-- (a later change to the plan never changes what a store listing already sells).
--
-- Safe to run again: a row that already exists (an admin made it first) is left as it is. `updatedBy` stays null, which
-- is how rollback.sql tells these rows from an admin's. Sort orders sit after the ladder's 1 to 25.
-- Rollback: rollback.sql (removes the rows these inserts made that no purchase or intent names and no admin has touched).

INSERT INTO "StoreProduct" ("id", "platform", "storeProductId", "kind", "title", "grants", "referenceKobo", "active", "sortOrder", "updatedAt")
SELECT gen_random_uuid()::text, p."platform", s."storeProductId", s."kind"::"StoreProductKind", s."title", s."grants"::jsonb,
       s."referenceKobo", true, s."sortOrder", CURRENT_TIMESTAMP
  FROM (VALUES
    ('wawu.tier.verify',        'tier',           'Verify, 1 year',         '{"packId":null,"pack":null,"tierId":"verify","days":null}',   NULL::integer, 101),
    ('wawu.tier.plus',          'tier',           'Verify Plus, 1 year',    '{"packId":null,"pack":null,"tierId":"plus","days":null}',     NULL::integer, 102),
    ('wawu.tier.founding',      'tier',           'Founding Maker, 1 year', '{"packId":null,"pack":null,"tierId":"founding","days":null}', NULL::integer, 103),
    ('wawu.points.s',           'points',         'Points, small pack',     '{"packId":"s","pack":null,"tierId":null,"days":null}',        NULL::integer, 201),
    ('wawu.points.m',           'points',         'Points, medium pack',    '{"packId":"m","pack":null,"tierId":null,"days":null}',        NULL::integer, 202),
    ('wawu.points.l',           'points',         'Points, large pack',     '{"packId":"l","pack":null,"tierId":null,"days":null}',        NULL::integer, 203),
    ('wawu.credits.starter',    'credits',        'Credits, starter pack',  '{"packId":null,"pack":"starter","tierId":null,"days":null}',  50000,         301),
    ('wawu.credits.popular',    'credits',        'Credits, popular pack',  '{"packId":null,"pack":"popular","tierId":null,"days":null}',  100000,        302),
    ('wawu.credits.pro',        'credits',        'Credits, pro pack',      '{"packId":null,"pack":"pro","tierId":null,"days":null}',      200000,        303),
    ('wawu.more.products.5',    'extra_products', '5 more products',        '{"packId":null,"pack":null,"tierId":null,"days":null,"extraProducts":5}', NULL::integer, 401)
  ) AS s("storeProductId", "kind", "title", "grants", "referenceKobo", "sortOrder")
  CROSS JOIN (VALUES ('android'::"StorePlatform"), ('ios'::"StorePlatform")) AS p("platform")
ON CONFLICT ("platform", "storeProductId") DO NOTHING;
