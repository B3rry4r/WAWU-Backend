-- EXPLORE-03: admin-featured creators for Explore. Additive: one new table,
-- no existing column, index or row touched (protected route registry, H-1).
-- Rollback: DROP TABLE "FeaturedCreator";

-- CreateTable
CREATE TABLE "FeaturedCreator" (
    "wawuUserId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "featuredByAdminId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeaturedCreator_pkey" PRIMARY KEY ("wawuUserId")
);

-- CreateIndex
CREATE INDEX "FeaturedCreator_position_idx" ON "FeaturedCreator"("position");
