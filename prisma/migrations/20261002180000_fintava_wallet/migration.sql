-- WAWU's pointer to each person's Fintava wallet (task MONEY-11).
--
-- Additive only: one new table and nothing else. It holds Fintava's ids for a
-- person's account and no money figure: the balance is always read from
-- Fintava (GET /money/wallet/balance), never stored or summed here. Nobody has
-- a row until MONEY-12 opens their account, so every existing person reads as
-- "no wallet yet" (R-6), and the web, which never calls the money routes, is
-- unaffected.
CREATE TABLE "FintavaWallet" (
    "wawuUserId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FintavaWallet_pkey" PRIMARY KEY ("wawuUserId")
);

-- CreateIndex
CREATE UNIQUE INDEX "FintavaWallet_customerId_key" ON "FintavaWallet"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "FintavaWallet_walletId_key" ON "FintavaWallet"("walletId");

-- CreateIndex
CREATE UNIQUE INDEX "FintavaWallet_accountNumber_key" ON "FintavaWallet"("accountNumber");
