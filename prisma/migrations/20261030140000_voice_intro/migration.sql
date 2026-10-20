-- VOICE-01: a person's voice (how their name is said, their Voice Intro with
-- the consent and the 30 second sample), the tries at making an intro, and a
-- count of free name previews. Additive only: three new tables; no existing
-- table, column, enum or constraint changes (AiJobState is reused as is).
--
-- "VoiceIntroRun" holds no script. A run is free when the tier's included first
-- Voice Intro paid for it ("includedUsed", no hold) or paid in points held by
-- POINTS-03 ("holdId"); never both. One "working" run per person at a time.
--
-- Rollback: see rollback.sql in this folder (drops the three tables).

-- CreateTable
CREATE TABLE "VoiceProfile" (
    "wawuUserId" TEXT NOT NULL,
    "namePhonetic" TEXT,
    "nameSavedAt" TIMESTAMP(3),
    "introText" TEXT,
    "introTextAt" TIMESTAMP(3),
    "consentAt" TIMESTAMP(3),
    "consentLine" TEXT,
    "sampleKey" TEXT,
    "sampleAt" TIMESTAMP(3),
    "sampleConsentAt" TIMESTAMP(3),
    "audioKey" TEXT,
    "audioAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VoiceProfile_pkey" PRIMARY KEY ("wawuUserId"),
    CONSTRAINT "VoiceProfile_consent_check" CHECK (("consentAt" IS NULL) = ("consentLine" IS NULL)),
    CONSTRAINT "VoiceProfile_sample_check" CHECK (("sampleKey" IS NULL) = ("sampleAt" IS NULL))
);

-- CreateTable
CREATE TABLE "VoiceIntroRun" (
    "id" TEXT NOT NULL,
    "wawuUserId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "characters" INTEGER NOT NULL,
    "costPoints" INTEGER NOT NULL,
    "includedUsed" BOOLEAN NOT NULL DEFAULT false,
    "state" "AiJobState" NOT NULL DEFAULT 'working',
    "holdId" TEXT,
    "failureCode" TEXT,
    "audioKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "VoiceIntroRun_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "VoiceIntroRun_sizes_check" CHECK ("characters" >= 1 AND "costPoints" >= 0),
    CONSTRAINT "VoiceIntroRun_funding_check" CHECK (NOT ("includedUsed" AND "holdId" IS NOT NULL) AND (NOT "includedUsed" OR "costPoints" = 0)),
    CONSTRAINT "VoiceIntroRun_failure_check" CHECK (("state" = 'failed') = ("failureCode" IS NOT NULL)),
    CONSTRAINT "VoiceIntroRun_audio_check" CHECK ("audioKey" IS NULL OR "state" = 'done')
);

-- CreateTable
CREATE TABLE "VoiceNamePreview" (
    "id" TEXT NOT NULL,
    "wawuUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VoiceNamePreview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VoiceIntroRun_wawuUserId_idempotencyKey_key" ON "VoiceIntroRun"("wawuUserId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "VoiceIntroRun_wawuUserId_createdAt_idx" ON "VoiceIntroRun"("wawuUserId", "createdAt");

-- CreateIndex
CREATE INDEX "VoiceIntroRun_state_createdAt_idx" ON "VoiceIntroRun"("state", "createdAt");

-- One run in flight per person: two tries at once with different keys cannot
-- both spend the included first Voice Intro or both hold points.
CREATE UNIQUE INDEX "VoiceIntroRun_one_working_per_person" ON "VoiceIntroRun"("wawuUserId") WHERE "state" = 'working';

-- CreateIndex
CREATE INDEX "VoiceNamePreview_wawuUserId_createdAt_idx" ON "VoiceNamePreview"("wawuUserId", "createdAt");
