-- The conversation on a legal matter: AI first, consultant after, one thread.
-- ADDITIVE ONLY: one enum, one new table, one index. No ALTER on an existing
-- table (hazard H-1).

CREATE TYPE "LegalChatAuthor" AS ENUM ('client', 'ai', 'consultant');

CREATE TABLE "LegalChatMessage" (
  "id"             TEXT NOT NULL,
  "legalRequestId" TEXT NOT NULL,
  "authorRole"     "LegalChatAuthor" NOT NULL,
  "authorAdminId"  TEXT,
  "body"           TEXT NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "LegalChatMessage_pkey" PRIMARY KEY ("id")
);

-- The only read: one matter's thread, oldest first.
CREATE INDEX "LegalChatMessage_legalRequestId_createdAt_idx"
  ON "LegalChatMessage" ("legalRequestId", "createdAt");
