-- FEE-01 (R-139, owner, 11 Nov 2026): WAWU's fee schedule with history, the provider's rates in their own table, a fee
-- record per provider transaction, and two product switches.
--
-- Additive only: four new tables, no change to any existing table or column. One data change: the saved admin setting
-- `fx.product.swap.on` is set to 0 (R-139 point 3: swaps stay off until the owner confirms). Nothing is written to a
-- table the web or the dashboard reads except that one PlanSetting row.
--
-- "FeeSchedule" and "ProviderRate" are histories: triggers refuse UPDATE, DELETE and TRUNCATE on both, so a change is a new
-- row and the old one stays. Starting fees are the first rows (changed by 'R-139 seed'), start at the moment this
-- runs. Safe to run again: the seed rows are inserted only while the table is empty.

CREATE TABLE "FeeSchedule" (
  "id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "currency" TEXT NOT NULL,
  "percentPpm" INTEGER NOT NULL DEFAULT 0,
  "minMinor" BIGINT NOT NULL DEFAULT 0,
  "maxMinor" BIGINT,
  "passThrough" BOOLEAN NOT NULL DEFAULT false,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "changedBy" TEXT NOT NULL,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FeeSchedule_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FeeSchedule_percent_check" CHECK ("percentPpm" >= 0 AND "percentPpm" <= 1000000),
  CONSTRAINT "FeeSchedule_range_check" CHECK ("minMinor" >= 0 AND ("maxMinor" IS NULL OR "maxMinor" >= "minMinor"))
);
CREATE INDEX "FeeSchedule_kind_currency_startsAt_idx" ON "FeeSchedule"("kind", "currency", "startsAt");

CREATE TABLE "ProviderRate" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "currency" TEXT NOT NULL,
  "percentPpm" INTEGER NOT NULL DEFAULT 0,
  "minMinor" BIGINT NOT NULL DEFAULT 0,
  "maxMinor" BIGINT,
  "fixedMinor" BIGINT NOT NULL DEFAULT 0,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "changedBy" TEXT NOT NULL,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderRate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProviderRate_percent_check" CHECK ("percentPpm" >= 0 AND "percentPpm" <= 1000000),
  CONSTRAINT "ProviderRate_range_check" CHECK ("minMinor" >= 0 AND "fixedMinor" >= 0 AND ("maxMinor" IS NULL OR "maxMinor" >= "minMinor"))
);
CREATE INDEX "ProviderRate_provider_kind_currency_startsAt_idx" ON "ProviderRate"("provider", "kind", "currency", "startsAt");

CREATE TABLE "MoneyFeeRecord" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'nuvion',
  "reference" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "currency" TEXT NOT NULL,
  "amountMinor" BIGINT NOT NULL,
  "wawuFeeMinor" BIGINT NOT NULL,
  "vatMinor" BIGINT NOT NULL DEFAULT 0,
  "providerExpectedMinor" BIGINT NOT NULL DEFAULT 0,
  "providerActualMinor" BIGINT,
  "keptMinor" BIGINT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "feeScheduleId" TEXT,
  "providerRateId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MoneyFeeRecord_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MoneyFeeRecord_provider_reference_kind_key" ON "MoneyFeeRecord"("provider", "reference", "kind");
CREATE INDEX "MoneyFeeRecord_createdAt_idx" ON "MoneyFeeRecord"("createdAt");

CREATE TABLE "FeeAlertSent" (
  "kind" TEXT NOT NULL,
  "sentAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FeeAlertSent_pkey" PRIMARY KEY ("kind")
);

-- History tables are append-only.
CREATE FUNCTION "fee_history_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is a history: add a new row instead of changing or deleting one', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "FeeSchedule_append_only" BEFORE UPDATE OR DELETE ON "FeeSchedule"
  FOR EACH ROW EXECUTE FUNCTION "fee_history_append_only"();
CREATE TRIGGER "ProviderRate_append_only" BEFORE UPDATE OR DELETE ON "ProviderRate"
  FOR EACH ROW EXECUTE FUNCTION "fee_history_append_only"();
-- TRUNCATE is a statement, not a row: it needs its own trigger.
CREATE FUNCTION "fee_history_no_truncate"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is a history: it cannot be emptied', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "FeeSchedule_no_truncate" BEFORE TRUNCATE ON "FeeSchedule"
  FOR EACH STATEMENT EXECUTE FUNCTION "fee_history_no_truncate"();
CREATE TRIGGER "ProviderRate_no_truncate" BEFORE TRUNCATE ON "ProviderRate"
  FOR EACH STATEMENT EXECUTE FUNCTION "fee_history_no_truncate"();

-- R-139 point 2: the starting fees, as the first rows of the history.
INSERT INTO "FeeSchedule" ("id", "kind", "currency", "percentPpm", "minMinor", "maxMinor", "passThrough", "startsAt", "changedBy", "note")
SELECT gen_random_uuid()::text, v.kind, v.currency, v.ppm, v.min_minor, v.max_minor, v.pass_through,
       (now() AT TIME ZONE 'UTC'), 'R-139 seed', 'Starting fee, R-139 point 2'
FROM (VALUES
  ('ngn_bank_withdrawal', 'NGN', 4000, 10000::bigint, 70000::bigint, false),
  ('usd_bank_payout', 'USD', 10000, 800::bigint, 6000::bigint, false),
  ('intl_wire_in', 'USD', 12500, 3000::bigint, 75000::bigint, false),
  ('usd_local_in', 'USD', 15000, 700::bigint, NULL::bigint, false),
  ('fx_swap', 'USD', 20000, 100::bigint, NULL::bigint, false),
  ('wallet_to_wallet', 'NGN', 0, 0::bigint, NULL::bigint, false),
  ('ngn_add_money', 'NGN', 0, 0::bigint, NULL::bigint, true)
) AS v(kind, currency, ppm, min_minor, max_minor, pass_through)
WHERE NOT EXISTS (SELECT 1 FROM "FeeSchedule");

-- Nuvion's rates (owner's copy of its commercials, effective 1 Jun 2026; tasks/NUV-FEES.md).
INSERT INTO "ProviderRate" ("id", "provider", "kind", "currency", "percentPpm", "minMinor", "maxMinor", "fixedMinor", "startsAt", "changedBy", "note")
SELECT gen_random_uuid()::text, 'nuvion', v.kind, v.currency, v.ppm, v.min_minor, v.max_minor, v.fixed_minor,
       (now() AT TIME ZONE 'UTC'), 'R-139 seed', v.note
FROM (VALUES
  ('ngn_bank_withdrawal', 'NGN', 2000, 5000::bigint, 50000::bigint, 0::bigint, 'Payout to a Nigerian bank'),
  ('ngn_add_money', 'NGN', 2000, 5000::bigint, NULL::bigint, 0::bigint, 'Receive a domestic transfer'),
  ('wallet_to_wallet', 'NGN', 0, 0::bigint, NULL::bigint, 0::bigint, 'Book transfer, free'),
  ('card_issuance', 'USD', 0, 0::bigint, NULL::bigint, 100::bigint, 'Virtual card issuance, per card'),
  ('card_maintenance', 'USD', 0, 0::bigint, NULL::bigint, 250::bigint, 'Card monthly maintenance, per card'),
  ('card_decline', 'USD', 0, 0::bigint, NULL::bigint, 100::bigint, 'Card decline, per declined transaction')
) AS v(kind, currency, ppm, min_minor, max_minor, fixed_minor, note)
WHERE NOT EXISTS (SELECT 1 FROM "ProviderRate");

-- R-139 point 3: swaps stay off until the owner confirms. A saved row is set to 0; with none, one is added.
INSERT INTO "PlanSetting" ("key", "value", "updatedAt") VALUES ('fx.product.swap.on', '0'::jsonb, now())
ON CONFLICT ("key") DO UPDATE SET "value" = '0'::jsonb, "updatedAt" = now();
