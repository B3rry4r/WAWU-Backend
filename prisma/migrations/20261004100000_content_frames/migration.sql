-- HOME-05: the ordered pictures of a photo set. Additive: one new table, no
-- existing column, index or row touched (ContentPiece gains a relation field
-- only, no column, so no content response gains a key; protected-registry
-- H-1). Rollback: DROP TABLE "ContentFrame";

-- CreateTable
CREATE TABLE "ContentFrame" (
    "id" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentFrame_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ContentFrame_contentId_position_key" ON "ContentFrame"("contentId", "position");

-- AddForeignKey
ALTER TABLE "ContentFrame" ADD CONSTRAINT "ContentFrame_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "ContentPiece"("id") ON DELETE CASCADE ON UPDATE CASCADE;
