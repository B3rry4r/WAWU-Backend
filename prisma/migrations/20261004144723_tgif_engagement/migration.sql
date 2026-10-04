-- HOME-10: TGIF reactions (one per person per card per day), readers (one per
-- person per day) and shares (one per person per day). Additive: three new
-- tables, no existing table, column, index or row touched. Rollback:
-- DROP TABLE "TgifReaction", "TgifRead", "TgifShare";
-- (then DELETE FROM "_prisma_migrations" WHERE migration_name = '20261004144723_tgif_engagement').

-- CreateTable
CREATE TABLE "TgifReaction" (
    "id" TEXT NOT NULL,
    "userWawuId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "card" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'amen',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TgifReaction_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TgifReaction_kind_known" CHECK ("kind" IN ('amen')),
    CONSTRAINT "TgifReaction_card_known" CHECK ("card" IN ('verse', 'reality', 'remember', 'prayer', 'takeaway'))
);

-- CreateTable
CREATE TABLE "TgifRead" (
    "id" TEXT NOT NULL,
    "userWawuId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TgifRead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TgifShare" (
    "id" TEXT NOT NULL,
    "userWawuId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TgifShare_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TgifReaction_day_card_idx" ON "TgifReaction"("day", "card");

-- CreateIndex
CREATE UNIQUE INDEX "TgifReaction_userWawuId_day_card_key" ON "TgifReaction"("userWawuId", "day", "card");

-- CreateIndex
CREATE INDEX "TgifRead_day_idx" ON "TgifRead"("day");

-- CreateIndex
CREATE UNIQUE INDEX "TgifRead_userWawuId_day_key" ON "TgifRead"("userWawuId", "day");

-- CreateIndex
CREATE INDEX "TgifShare_day_idx" ON "TgifShare"("day");

-- CreateIndex
CREATE UNIQUE INDEX "TgifShare_userWawuId_day_key" ON "TgifShare"("userWawuId", "day");
