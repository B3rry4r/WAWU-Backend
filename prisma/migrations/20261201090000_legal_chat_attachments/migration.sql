-- R2-LEGAL3. A person sends the documents a matter needs (an ID picture, a PDF) in the Legal chat, before the work starts. The line
-- carries the storage key of a chat upload (FIX-104 folders), its type, its size and the name a PDF shows. Additive only: four nullable
-- columns on LegalChatMessage and a unique index on the key (a key rides on at most one line; nulls are not compared).

-- AlterTable
ALTER TABLE "LegalChatMessage" ADD COLUMN     "attachmentBytes" INTEGER,
ADD COLUMN     "attachmentContentType" TEXT,
ADD COLUMN     "attachmentKey" TEXT,
ADD COLUMN     "attachmentName" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "LegalChatMessage_attachmentKey_key" ON "LegalChatMessage"("attachmentKey");
