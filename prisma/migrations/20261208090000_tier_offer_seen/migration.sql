-- TIER-OFFER (R-94): that a person has been shown the full-screen offer of the three tiers, and when. Additive: one new table, no
-- existing column, index, constraint or row is touched (protected route registry: nothing the web or the dashboard calls changes).
--
-- One row per person ("wawuUserId" is the key), written once by the app when the offer is drawn. The table starts empty: nobody
-- has seen the offer yet, so every creator without a tier is shown it once. Rollback: see rollback.sql (refuses while any row exists).

-- CreateTable
CREATE TABLE "TierOfferSeen" (
    "wawuUserId" TEXT NOT NULL,
    "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TierOfferSeen_pkey" PRIMARY KEY ("wawuUserId")
);
