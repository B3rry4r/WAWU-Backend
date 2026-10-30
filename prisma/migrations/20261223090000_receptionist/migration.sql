-- AITOOLS-06 (R-109, owner, 30 Oct 2026): the Receptionist, a talking AI agent a creator sets up with knowledge from
-- their own documents, pages and text. This adds THREE tables and nothing else: nothing the web, the dashboard or the
-- live app calls reads them.
--
-- "ReceptionistAgent" is one row a person (the unique index): the business fields and the provider's agent id, which is
-- empty while the agent is being made. "ReceptionistKnowledge" is one row for each text, web page or document the agent
-- knows; its "providerDocId" is the provider's copy, deleted when the row is removed. "ReceptionistTurn" keeps a bounded
-- number of the person's latest messages and replies so the next reply has context. The count of documents and turns
-- is held by the application (the settings ai.receptionist_docs_max and ai.receptionist_history_turns), not by an index.
--
-- Rollback: rollback.sql in this folder. It refuses while any row exists, because a row is a thing a person gave the
-- Receptionist (and the provider may still hold a copy of).

-- CreateTable
CREATE TABLE "ReceptionistAgent" (
    "id" TEXT NOT NULL,
    "wawuUserId" TEXT NOT NULL,
    "providerAgentId" TEXT,
    "businessName" TEXT NOT NULL,
    "offer" TEXT NOT NULL,
    "replyStyle" TEXT NOT NULL DEFAULT '',
    "language" TEXT NOT NULL DEFAULT 'en',
    "voiceId" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReceptionistAgent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ReceptionistAgent_name_check" CHECK (char_length("businessName") BETWEEN 1 AND 120),
    CONSTRAINT "ReceptionistAgent_provider_id_check" CHECK ("providerAgentId" IS NULL OR char_length("providerAgentId") BETWEEN 1 AND 100)
);

-- CreateTable
CREATE TABLE "ReceptionistKnowledge" (
    "id" TEXT NOT NULL,
    "wawuUserId" TEXT NOT NULL,
    "providerDocId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReceptionistKnowledge_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ReceptionistKnowledge_kind_check" CHECK ("kind" IN ('text', 'url', 'file')),
    CONSTRAINT "ReceptionistKnowledge_name_check" CHECK (char_length("name") BETWEEN 1 AND 120)
);

-- CreateTable
CREATE TABLE "ReceptionistTurn" (
    "id" TEXT NOT NULL,
    "wawuUserId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReceptionistTurn_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ReceptionistTurn_role_check" CHECK ("role" IN ('person', 'agent'))
);

-- CreateIndex
CREATE UNIQUE INDEX "ReceptionistAgent_wawuUserId_key" ON "ReceptionistAgent"("wawuUserId");

-- CreateIndex
CREATE INDEX "ReceptionistKnowledge_wawuUserId_idx" ON "ReceptionistKnowledge"("wawuUserId");

-- CreateIndex
CREATE INDEX "ReceptionistTurn_wawuUserId_createdAt_idx" ON "ReceptionistTurn"("wawuUserId", "createdAt");
