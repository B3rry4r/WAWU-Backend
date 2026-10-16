-- The nightly check against the wallet provider (task MONEY-16).
--
-- Additive only: one new table ("MoneyCheckRun"). No existing table, column,
-- index or row is touched and nothing is backfilled.
--
-- One row per run of the nightly check, which reads WAWU's ledger and the
-- provider's own record and reports any difference; it never changes a ledger
-- row, a hold, a payment or a balance. The unique key ("provider", "night",
-- "sequence") is the lock that lets two Hub processes share one schedule:
-- "night" is the Lagos date the run belongs to, "sequence" is 1 for the
-- scheduled run and counts up for a run made again by hand. A run that dies
-- stays "running" with an old "leaseUntil" and is taken over after it.
--
-- What the database refuses, so the rules hold whatever the code does:
--   * a status other than running, failed or finished; a verdict other than
--     clean, needs_a_look, differences, incomplete or not_checked;
--   * a finished run without its finish time, its verdict or its report (a
--     run never counts as done half-reported), or an unfinished run with a
--     verdict (a half run is never clean);
--   * a night that is not a YYYY-MM-DD date; a sequence or attempt below 1.
--
-- Rollback: DROP TABLE "MoneyCheckRun";

-- CreateTable
CREATE TABLE "MoneyCheckRun" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'fintava',
    "night" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'running',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "byHand" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "leaseUntil" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "windowFrom" TIMESTAMP(3),
    "windowTo" TIMESTAMP(3),
    "verdict" TEXT,
    "walletsTotal" INTEGER,
    "walletsChecked" INTEGER,
    "mismatchCount" INTEGER,
    "lookCount" INTEGER,
    "report" JSONB,
    "failure" TEXT,
    "emailedTo" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "emailAttempts" INTEGER NOT NULL DEFAULT 0,
    "nextEmailAt" TIMESTAMP(3),
    "emailedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MoneyCheckRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MoneyCheckRun_provider_night_sequence_key" ON "MoneyCheckRun"("provider", "night", "sequence");

-- CreateIndex
CREATE INDEX "MoneyCheckRun_provider_status_finishedAt_idx" ON "MoneyCheckRun"("provider", "status", "finishedAt");

-- CreateIndex
CREATE INDEX "MoneyCheckRun_emailedAt_finishedAt_idx" ON "MoneyCheckRun"("emailedAt", "finishedAt");

-- The rules above, enforced by the database.
ALTER TABLE "MoneyCheckRun"
    ADD CONSTRAINT "MoneyCheckRun_status_check"
        CHECK ("status" IN ('running', 'failed', 'finished')),
    ADD CONSTRAINT "MoneyCheckRun_verdict_check"
        CHECK ("verdict" IS NULL OR "verdict" IN ('clean', 'needs_a_look', 'differences', 'incomplete', 'not_checked')),
    ADD CONSTRAINT "MoneyCheckRun_finished_check"
        CHECK (
            ("status" = 'finished' AND "finishedAt" IS NOT NULL AND "verdict" IS NOT NULL AND "report" IS NOT NULL)
            OR ("status" <> 'finished' AND "verdict" IS NULL)
        ),
    ADD CONSTRAINT "MoneyCheckRun_night_check"
        CHECK ("night" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
    ADD CONSTRAINT "MoneyCheckRun_counters_check"
        CHECK ("sequence" >= 1 AND "attempt" >= 1 AND "emailAttempts" >= 0);
