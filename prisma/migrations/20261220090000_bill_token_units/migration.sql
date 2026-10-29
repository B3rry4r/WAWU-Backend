-- BILLS-09 (R-102, owner, 29 Oct 2026): bills are paid through Flutterwave checkout on the website's Hub routes, and a
-- prepaid electricity bill is useless without its token. The Hub kept none, so the app could not show one.
--
-- Additive only. The web and the dashboard read none of this:
--   * "BillPayment" gains nullable "token" and "units": what the provider's purchase answer and its bill status answer
--     carry for a prepaid electricity bill, null for every row that exists today and for every bill with none;
--   * "BillPayment" gains nullable "providerCheckedAt": when the provider was last asked about the bill, so the buyer's
--     status read asks again only after 20 seconds and two reads at once ask once.
--
-- Rollback: rollback.sql in this folder. It refuses while any bill holds a token or units, because a token is the thing
-- a person paid for and the provider may not hand it out a second time.

-- AlterTable
ALTER TABLE "BillPayment" ADD COLUMN "token" TEXT,
ADD COLUMN "units" TEXT,
ADD COLUMN "providerCheckedAt" TIMESTAMP(3);
