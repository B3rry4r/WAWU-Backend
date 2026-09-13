-- One user's like on one comment. The heart on a content-piece comment used
-- to be decorative, with no way to record who liked what or to stop a
-- double-like; this table exists so POST/DELETE .../like are idempotent.
CREATE TABLE "CommentLike" (
    "id" TEXT NOT NULL,
    "userWawuId" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "likedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommentLike_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CommentLike_userWawuId_commentId_key" ON "CommentLike"("userWawuId", "commentId");

CREATE INDEX "CommentLike_userWawuId_idx" ON "CommentLike"("userWawuId");

CREATE INDEX "CommentLike_commentId_idx" ON "CommentLike"("commentId");

ALTER TABLE "CommentLike" ADD CONSTRAINT "CommentLike_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "Comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
