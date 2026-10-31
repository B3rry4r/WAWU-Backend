-- REPORT-UGC (store review: Apple guideline 1.2, Google Play's user-generated content policy). A person can report a
-- piece, a comment, a profile, a community message, a chat message or a paid question from where they see it. This adds
-- ONE table and nothing else: nothing the web, the dashboard or the live app calls reads it (the paid-question report
-- keeps its own table "DmReport", unchanged).
--
-- "kind" is one of piece, comment, profile, community_message, chat_message, direct_message. "targetId" is that thing's
-- id (a profile's is the person's id); no foreign key, because it points at one of six tables. "subjectWawuId" is the
-- person who made the thing. One report per person per thing: the unique index below. "status" is open, dismissed or
-- actioned (the thing was taken down). "reason" is one of the fixed list the Hub serves.
--
-- Rollback: rollback.sql in this folder. It refuses while any row exists, because a row is a report a moderator may
-- still have to answer.

-- CreateTable
CREATE TABLE "UgcReport" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "subjectWawuId" TEXT NOT NULL,
    "reporterWawuId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolution" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByAdminId" TEXT,
    "resolvedByAdminEmail" TEXT,
    "resolvedByAdminRole" "AdminRole",
    "emailedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UgcReport_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "UgcReport_kind_check" CHECK ("kind" IN ('piece', 'comment', 'profile', 'community_message', 'chat_message', 'direct_message')),
    CONSTRAINT "UgcReport_status_check" CHECK ("status" IN ('open', 'dismissed', 'actioned')),
    CONSTRAINT "UgcReport_note_check" CHECK ("note" IS NULL OR char_length("note") <= 500)
);

-- CreateIndex
CREATE UNIQUE INDEX "UgcReport_reporterWawuId_kind_targetId_key" ON "UgcReport"("reporterWawuId", "kind", "targetId");

-- CreateIndex
CREATE INDEX "UgcReport_status_createdAt_idx" ON "UgcReport"("status", "createdAt");

-- CreateIndex
CREATE INDEX "UgcReport_kind_targetId_idx" ON "UgcReport"("kind", "targetId");

-- CreateIndex
CREATE INDEX "UgcReport_subjectWawuId_idx" ON "UgcReport"("subjectWawuId");

-- CreateIndex
CREATE INDEX "UgcReport_reporterWawuId_kind_idx" ON "UgcReport"("reporterWawuId", "kind");
