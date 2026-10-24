-- NUV-11 fix round 2 (R1-4). Sends abroad: when the question of WAWU's fee on a send is closed (a fee that could not be taken is
-- written off after the sweep's last try, a give-back finance paid outside is settled, a fee leg that never completed on a send that
-- failed is closed) and how. Additive only: two nullable columns on the table created by 20261113093000_abroad_sends.

-- AlterTable
ALTER TABLE "AbroadSend" ADD COLUMN     "feeSettledAt" TIMESTAMP(3),
ADD COLUMN     "feeSettledHow" TEXT;
