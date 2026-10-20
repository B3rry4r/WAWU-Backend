-- Recent searches and popular searches (task EXPLORE-05).
--
-- Additive only: one new table. No existing column, index or row changes
-- meaning.
--
-- SearchHistory: one row per person and normalised search text. "queryKey" is
-- the text trimmed, with runs of spaces made one, and lowercased; "query" is
-- what the person last typed. Searching the same text again moves the row to
-- the top ("searchedAt"). "People are searching" counts the different people
-- who searched a text lately, from this table, so Clear removes a person's
-- text from it too.
--
-- Rollback: DROP TABLE "SearchHistory";

-- CreateTable
CREATE TABLE "SearchHistory" (
    "userWawuId" TEXT NOT NULL,
    "queryKey" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "searchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SearchHistory_pkey" PRIMARY KEY ("userWawuId","queryKey")
);

-- CreateIndex
CREATE INDEX "SearchHistory_userWawuId_searchedAt_idx" ON "SearchHistory"("userWawuId", "searchedAt");

-- CreateIndex
CREATE INDEX "SearchHistory_searchedAt_queryKey_idx" ON "SearchHistory"("searchedAt", "queryKey");
