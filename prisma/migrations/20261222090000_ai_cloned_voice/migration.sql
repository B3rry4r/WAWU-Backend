-- AITOOLS-11 (R-109, owner, 30 Oct 2026): "Clone your own voice". A person keeps a clone of their own voice that the
-- voice tools (VoiceOver, Quick voice, Dialogue, Voice changer) can read in. This adds ONE table and nothing else:
-- nothing the web, the dashboard or the live app calls reads it.
--
-- "AiClonedVoice" is one row per clone a person made. The row is written (the reservation, "providerVoiceId" still
-- empty) before the provider is asked, so a double tap makes one clone; "providerVoiceId" is filled the moment the
-- provider answers. "removedAt" is set when the person removes it: the voice then leaves their lists at once and the
-- row is deleted when the provider has dropped its copy. The cap on clones per person and in all is held by the
-- application under an advisory lock (the settings ai.clones_per_person and ai.clones_total_max), not by an index.
-- "consentLine" and "consentAt" are the exact words the person agreed to and when.
--
-- Rollback: rollback.sql in this folder. It refuses while any row exists, because a row is a voice the provider may
-- still hold and a consent the person gave.

-- CreateTable
CREATE TABLE "AiClonedVoice" (
    "id" TEXT NOT NULL,
    "wawuUserId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "providerVoiceId" TEXT,
    "name" TEXT NOT NULL,
    "consentLine" TEXT NOT NULL,
    "consentAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "AiClonedVoice_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AiClonedVoice_name_check" CHECK (char_length("name") BETWEEN 1 AND 80),
    CONSTRAINT "AiClonedVoice_provider_id_check" CHECK ("providerVoiceId" IS NULL OR char_length("providerVoiceId") BETWEEN 1 AND 100)
);

-- CreateIndex
CREATE UNIQUE INDEX "AiClonedVoice_jobId_key" ON "AiClonedVoice"("jobId");

-- CreateIndex
CREATE INDEX "AiClonedVoice_wawuUserId_idx" ON "AiClonedVoice"("wawuUserId");

-- CreateIndex
CREATE INDEX "AiClonedVoice_removedAt_idx" ON "AiClonedVoice"("removedAt");
