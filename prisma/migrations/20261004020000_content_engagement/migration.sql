-- HOME-04: per-viewer likes, one view per viewer per day, one share per sharer
-- per day. Additive: three new tables, no existing column, index or row
-- touched (ContentPiece gains no column, so no content response gains a key;
-- protected route registry, entry H-1). Rollback: DROP TABLE "ContentLike", "ContentView",
-- "ContentShare";

-- CreateTable
CREATE TABLE "ContentLike" (
    "id" TEXT NOT NULL,
    "userWawuId" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "likedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentLike_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentView" (
    "id" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "viewerWawuId" TEXT NOT NULL,
    "viewedOn" DATE NOT NULL,
    "viewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentView_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentShare" (
    "id" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "sharerWawuId" TEXT NOT NULL,
    "sharedOn" DATE NOT NULL,
    "sharedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentShare_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContentLike_userWawuId_idx" ON "ContentLike"("userWawuId");

-- CreateIndex
CREATE INDEX "ContentLike_contentId_idx" ON "ContentLike"("contentId");

-- CreateIndex
CREATE UNIQUE INDEX "ContentLike_userWawuId_contentId_key" ON "ContentLike"("userWawuId", "contentId");

-- CreateIndex
CREATE INDEX "ContentView_viewerWawuId_idx" ON "ContentView"("viewerWawuId");

-- CreateIndex
CREATE UNIQUE INDEX "ContentView_contentId_viewerWawuId_viewedOn_key" ON "ContentView"("contentId", "viewerWawuId", "viewedOn");

-- CreateIndex
CREATE INDEX "ContentShare_sharerWawuId_idx" ON "ContentShare"("sharerWawuId");

-- CreateIndex
CREATE UNIQUE INDEX "ContentShare_contentId_sharerWawuId_sharedOn_key" ON "ContentShare"("contentId", "sharerWawuId", "sharedOn");

-- AddForeignKey
ALTER TABLE "ContentLike" ADD CONSTRAINT "ContentLike_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "ContentPiece"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentView" ADD CONSTRAINT "ContentView_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "ContentPiece"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentShare" ADD CONSTRAINT "ContentShare_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "ContentPiece"("id") ON DELETE CASCADE ON UPDATE CASCADE;

