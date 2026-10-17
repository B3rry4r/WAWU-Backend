-- POINTS-03: spending points on AI tools.
-- Additive only: one new table and one new index.

-- A person's choices about points ("Use wallet", off until they turn it on).
CREATE TABLE "PointsSetting" (
    "wawuUserId" TEXT NOT NULL,
    "useWallet" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PointsSetting_pkey" PRIMARY KEY ("wawuUserId")
);

-- The sweep of AI holds that stayed `held` past the job's longest run time.
CREATE INDEX "PointHold_state_createdAt_idx" ON "PointHold"("state", "createdAt");
