-- HOME-16: the marker that a person's daily TGIF notice was made for a day.
-- Additive: one new table, no existing table, column, index or row touched
-- (protected route registry, H-1). Rollback: DROP TABLE "TgifDailyNotice";
-- (then DELETE FROM "_prisma_migrations" WHERE migration_name = '20261024080000_tgif_daily_notice').

-- CreateTable
CREATE TABLE "TgifDailyNotice" (
    "userWawuId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TgifDailyNotice_pkey" PRIMARY KEY ("userWawuId","day")
);

-- CreateIndex
CREATE INDEX "TgifDailyNotice_day_idx" ON "TgifDailyNotice"("day");
