-- FLIX-01: Flix movies on the Hub (R-74, R-75). Additive only: four new tables;
-- no existing table, column, enum, index or constraint changes.
--
-- "MoviePartnerMovie" is the Hub's copy of the movie partner's catalog (no
-- person's data). "MoviePartnerSync" is where the sync job is. "MoviePartnerLink"
-- is one row per person from their first signed-in link (the link itself is
-- never stored). "MoviePartnerConsent" is a person's agreement to the terms
-- that name the partner, with its time and how.
--
-- Rollback: see rollback.sql in this folder (drops the four tables, and
-- refuses while any person's link or consent is stored).

-- CreateTable
CREATE TABLE "MoviePartnerMovie" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "partnerMovieId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "titleSort" TEXT NOT NULL,
    "originalTitle" TEXT,
    "synopsis" TEXT NOT NULL,
    "tagline" TEXT,
    "genre" TEXT[],
    "language" TEXT,
    "countryOfOrigin" TEXT,
    "year" INTEGER,
    "runtimeMinutes" INTEGER,
    "ageRating" TEXT,
    "posterImage" TEXT,
    "backdropImage" TEXT,
    "trailerUrl" TEXT,
    "trailerKind" TEXT,
    "castMembers" JSONB NOT NULL,
    "rating" DOUBLE PRECISION NOT NULL,
    "ratingCount" INTEGER NOT NULL,
    "views" INTEGER NOT NULL,
    "premiering" BOOLEAN NOT NULL,
    "premierDate" TIMESTAMP(3),
    "partnerAddedAt" TIMESTAMP(3) NOT NULL,
    "partnerPath" TEXT NOT NULL,
    "partnerUrl" TEXT NOT NULL,
    "seenAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MoviePartnerMovie_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MoviePartnerMovie_trailer_check" CHECK (("trailerKind" IS NULL) = ("trailerUrl" IS NULL)),
    CONSTRAINT "MoviePartnerMovie_trailer_kind_check" CHECK ("trailerKind" IS NULL OR "trailerKind" IN ('file', 'youtube')),
    CONSTRAINT "MoviePartnerMovie_counts_check" CHECK ("ratingCount" >= 0 AND "views" >= 0)
);

-- CreateTable
CREATE TABLE "MoviePartnerSync" (
    "provider" TEXT NOT NULL,
    "lastPassStartedAt" TIMESTAMP(3),
    "lastFullPassAt" TIMESTAMP(3),
    "lastPassAt" TIMESTAMP(3),
    "claimedUntil" TIMESTAMP(3),
    "lastError" TEXT,
    "lastCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MoviePartnerSync_pkey" PRIMARY KEY ("provider")
);

-- CreateTable
CREATE TABLE "MoviePartnerLink" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "wawuUserId" TEXT NOT NULL,
    "firstLinkAt" TIMESTAMP(3) NOT NULL,
    "lastLinkAt" TIMESTAMP(3) NOT NULL,
    "linkCount" INTEGER NOT NULL DEFAULT 1,
    "accountDeletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MoviePartnerLink_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MoviePartnerLink_count_check" CHECK ("linkCount" >= 1),
    CONSTRAINT "MoviePartnerLink_times_check" CHECK ("lastLinkAt" >= "firstLinkAt")
);

-- CreateTable
CREATE TABLE "MoviePartnerConsent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "wawuUserId" TEXT NOT NULL,
    "agreedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "how" TEXT NOT NULL,

    CONSTRAINT "MoviePartnerConsent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MoviePartnerConsent_how_check" CHECK ("how" IN ('signup', 'mv4'))
);

-- CreateIndex
CREATE UNIQUE INDEX "MoviePartnerMovie_provider_partnerMovieId_key" ON "MoviePartnerMovie"("provider", "partnerMovieId");

-- CreateIndex
CREATE INDEX "MoviePartnerMovie_provider_partnerAddedAt_idx" ON "MoviePartnerMovie"("provider", "partnerAddedAt");

-- CreateIndex
CREATE INDEX "MoviePartnerMovie_provider_views_idx" ON "MoviePartnerMovie"("provider", "views");

-- CreateIndex
CREATE INDEX "MoviePartnerMovie_provider_rating_idx" ON "MoviePartnerMovie"("provider", "rating");

-- CreateIndex
CREATE INDEX "MoviePartnerMovie_provider_titleSort_idx" ON "MoviePartnerMovie"("provider", "titleSort");

-- CreateIndex
CREATE INDEX "MoviePartnerMovie_provider_seenAt_idx" ON "MoviePartnerMovie"("provider", "seenAt");

-- CreateIndex
CREATE UNIQUE INDEX "MoviePartnerLink_provider_wawuUserId_key" ON "MoviePartnerLink"("provider", "wawuUserId");

-- CreateIndex
CREATE INDEX "MoviePartnerLink_wawuUserId_idx" ON "MoviePartnerLink"("wawuUserId");

-- CreateIndex
CREATE UNIQUE INDEX "MoviePartnerConsent_provider_wawuUserId_key" ON "MoviePartnerConsent"("provider", "wawuUserId");

-- CreateIndex
CREATE INDEX "MoviePartnerConsent_wawuUserId_idx" ON "MoviePartnerConsent"("wawuUserId");
