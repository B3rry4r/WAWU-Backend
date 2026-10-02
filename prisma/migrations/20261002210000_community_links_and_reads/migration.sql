-- INBOX-01: community share links (wawu/c/<slug>) and read markers.
-- Additive only: two new tables, no existing column, index or row touched.
-- Rollback: DROP TABLE "CommunityReadMarker"; DROP TABLE "CommunityLink";

-- CreateTable
CREATE TABLE "CommunityLink" (
    "communityId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommunityLink_pkey" PRIMARY KEY ("communityId")
);

-- CreateTable
CREATE TABLE "CommunityReadMarker" (
    "userWawuId" TEXT NOT NULL,
    "communityId" TEXT NOT NULL,
    "lastReadAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommunityReadMarker_pkey" PRIMARY KEY ("userWawuId","communityId")
);

-- CreateIndex
CREATE UNIQUE INDEX "CommunityLink_slug_key" ON "CommunityLink"("slug");

-- CreateIndex
CREATE INDEX "CommunityReadMarker_communityId_idx" ON "CommunityReadMarker"("communityId");

-- AddForeignKey
ALTER TABLE "CommunityLink" ADD CONSTRAINT "CommunityLink_communityId_fkey" FOREIGN KEY ("communityId") REFERENCES "Community"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunityReadMarker" ADD CONSTRAINT "CommunityReadMarker_communityId_fkey" FOREIGN KEY ("communityId") REFERENCES "Community"("id") ON DELETE CASCADE ON UPDATE CASCADE;
