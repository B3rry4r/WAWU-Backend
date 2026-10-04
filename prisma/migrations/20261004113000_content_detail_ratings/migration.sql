-- HOME-06: one star rating per person per piece, and the side row that holds
-- what the content detail screen shows beyond ContentPiece (free preview size,
-- last change). Additive: two new tables, no existing column, index or row
-- touched. ContentPiece gains no column, so no content response gains a key
-- (protected route registry, entry H-1).
-- Rollback: DROP TABLE "ContentRating", "ContentDetail";

-- CreateTable
CREATE TABLE "ContentRating" (
    "id" TEXT NOT NULL,
    "userWawuId" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "stars" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentRating_pkey" PRIMARY KEY ("id"),
    -- The range lives in the database too, so no code path can store a 0 or a 9.
    CONSTRAINT "ContentRating_stars_range" CHECK ("stars" BETWEEN 1 AND 5)
);

-- CreateTable
CREATE TABLE "ContentDetail" (
    "contentId" TEXT NOT NULL,
    "freePreviewPages" INTEGER,
    "freePreviewSeconds" INTEGER,
    "freePreviewLessons" INTEGER,
    "contentUpdatedAt" TIMESTAMP(3),

    CONSTRAINT "ContentDetail_pkey" PRIMARY KEY ("contentId"),
    CONSTRAINT "ContentDetail_free_positive" CHECK (
        COALESCE("freePreviewPages", 1) >= 1
        AND COALESCE("freePreviewSeconds", 1) >= 1
        AND COALESCE("freePreviewLessons", 1) >= 1
    )
);

-- CreateIndex
CREATE INDEX "ContentRating_userWawuId_idx" ON "ContentRating"("userWawuId");

-- CreateIndex
CREATE INDEX "ContentRating_contentId_idx" ON "ContentRating"("contentId");

-- CreateIndex
CREATE UNIQUE INDEX "ContentRating_userWawuId_contentId_key" ON "ContentRating"("userWawuId", "contentId");

-- AddForeignKey
ALTER TABLE "ContentRating" ADD CONSTRAINT "ContentRating_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "ContentPiece"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentDetail" ADD CONSTRAINT "ContentDetail_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "ContentPiece"("id") ON DELETE CASCADE ON UPDATE CASCADE;
