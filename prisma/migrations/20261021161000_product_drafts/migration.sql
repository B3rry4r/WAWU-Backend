-- TIER-02: product drafts (R-43, VF2). A creator may save a product with no
-- file for free; it holds no place against the tier's product count until it
-- is published (POST /product-drafts/:id/publish creates the content piece and
-- deletes the draft in one transaction).
--
-- Additive: one new table. No existing table, column, index or row is touched,
-- and no relation is added to an existing model, so no live response gains a
-- key (protected route registry, H-1).
--
-- Rollback:
--   DROP TABLE "ProductDraft";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261021161000_product_drafts';

-- CreateTable
CREATE TABLE "ProductDraft" (
    "id" TEXT NOT NULL,
    "wawuUserId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "contentType" "ContentType",
    "description" TEXT,
    "category" TEXT,
    "specializations" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "accessType" "AccessType",
    "price" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductDraft_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProductDraft_title_check" CHECK (length(btrim("title")) > 0),
    CONSTRAINT "ProductDraft_price_check" CHECK ("price" IS NULL OR "price" >= 0)
);

-- CreateIndex
CREATE INDEX "ProductDraft_wawuUserId_createdAt_idx" ON "ProductDraft"("wawuUserId", "createdAt");
