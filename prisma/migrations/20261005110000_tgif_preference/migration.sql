-- HOME-11: whether a person wants TGIF on Today, saved to the account.
-- Additive: one new table, no existing table, column, index or row touched
-- (protected route registry, H-1). Rollback: DROP TABLE "TgifPreference";
-- (then DELETE FROM "_prisma_migrations" WHERE migration_name = '20261005110000_tgif_preference').

-- CreateTable
CREATE TABLE "TgifPreference" (
    "userWawuId" TEXT NOT NULL,
    "show" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TgifPreference_pkey" PRIMARY KEY ("userWawuId")
);
