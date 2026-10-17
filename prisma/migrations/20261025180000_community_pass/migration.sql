-- INBOX-24 (R-63): a private community sells a monthly pass.
--
-- Two new tables, nothing else touched. "CommunityPassPrice" is the host's
-- monthly price for one private room (a side table, because every Community
-- response is the model spread and a new column would widen five responses the
-- web calls). "CommunityPass" is one paid pass, one row per wallet payment
-- ("walletPaymentId" is unique, so a payment confirmed twice grants once); a
-- person's pass runs to the latest "endsAt" of their rows.
--
-- Additive: no existing table, column, constraint or index changes. The web and
-- the dashboard never read these tables. A private room without a price row
-- behaves exactly as before.
--
-- Rollback: DROP TABLE "CommunityPass"; DROP TABLE "CommunityPassPrice";
-- (a pass is a record of money already taken: export it first if any row
-- exists, because the wallet payments stay and a dropped pass cannot be rebuilt).
-- CreateTable
CREATE TABLE "CommunityPassPrice" (
    "communityId" TEXT NOT NULL,
    "priceKobo" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommunityPassPrice_pkey" PRIMARY KEY ("communityId")
);

-- CreateTable
CREATE TABLE "CommunityPass" (
    "id" TEXT NOT NULL,
    "communityId" TEXT NOT NULL,
    "userWawuId" TEXT NOT NULL,
    "walletPaymentId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "priceKobo" BIGINT NOT NULL,
    "reminderSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommunityPass_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CommunityPass_walletPaymentId_key" ON "CommunityPass"("walletPaymentId");

-- CreateIndex
CREATE INDEX "CommunityPass_communityId_userWawuId_endsAt_idx" ON "CommunityPass"("communityId", "userWawuId", "endsAt");

-- CreateIndex
CREATE INDEX "CommunityPass_endsAt_idx" ON "CommunityPass"("endsAt");

-- AddForeignKey
ALTER TABLE "CommunityPassPrice" ADD CONSTRAINT "CommunityPassPrice_communityId_fkey" FOREIGN KEY ("communityId") REFERENCES "Community"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunityPass" ADD CONSTRAINT "CommunityPass_communityId_fkey" FOREIGN KEY ("communityId") REFERENCES "Community"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A price is positive, and a pass ends after it starts.
ALTER TABLE "CommunityPassPrice" ADD CONSTRAINT "CommunityPassPrice_priceKobo_positive" CHECK ("priceKobo" > 0);
ALTER TABLE "CommunityPass" ADD CONSTRAINT "CommunityPass_period_valid" CHECK ("endsAt" > "startsAt" AND "priceKobo" > 0);
