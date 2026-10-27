-- STORE-CUT30 (R-101 point 9): the Hub keeps each store's calendar-year total of WAWU's proceeds in US dollars, and when a
-- store reaches the threshold its `wawu.buy.*` prices move to the 30% ladder.
--
-- Additive only: two new tables. "StoreProceedsEntry" is one row per store purchase (its proceeds in kobo and in US
-- cents, with the FX figures used). "StoreCut30Switch" is one row per store and year, written when the total crossed the
-- threshold; its unique key is what makes the switch happen once. No existing table, column or row changes. The 30%
-- prices themselves are in code (src/store/cut30/store-ladder-30.ts), not in a table.
--
-- Rollback: rollback.sql in this folder. It refuses while either table has rows (the switch is a record of a price change
-- made in the stores, and the entries are the proof of the total).

-- CreateTable
CREATE TABLE "StoreProceedsEntry" (
    "id" TEXT NOT NULL,
    "storePurchaseId" TEXT NOT NULL,
    "platform" "StorePlatform" NOT NULL,
    "year" INTEGER NOT NULL,
    "proceedsKobo" BIGINT NOT NULL,
    "usdCents" BIGINT NOT NULL,
    "rateKobo" BIGINT NOT NULL,
    "rateCents" BIGINT NOT NULL,
    "rateSource" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoreProceedsEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreCut30Switch" (
    "id" TEXT NOT NULL,
    "platform" "StorePlatform" NOT NULL,
    "year" INTEGER NOT NULL,
    "totalUsdCents" BIGINT NOT NULL,
    "thresholdUsdCents" BIGINT NOT NULL,
    "crossedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "storeSync" TEXT,
    "noticedAt" TIMESTAMP(3),
    "backAt" TIMESTAMP(3),
    "backByAdminId" TEXT,

    CONSTRAINT "StoreCut30Switch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StoreProceedsEntry_storePurchaseId_key" ON "StoreProceedsEntry"("storePurchaseId");
CREATE INDEX "StoreProceedsEntry_platform_year_idx" ON "StoreProceedsEntry"("platform", "year");
CREATE UNIQUE INDEX "StoreCut30Switch_platform_year_key" ON "StoreCut30Switch"("platform", "year");

-- CheckConstraints: whole, positive-rate figures.
ALTER TABLE "StoreProceedsEntry" ADD CONSTRAINT "StoreProceedsEntry_amounts_check"
    CHECK ("proceedsKobo" >= 0 AND "usdCents" >= 0 AND "rateKobo" > 0 AND "rateCents" > 0);
