-- WALLET-16 (lead ruling 17 Oct 2026): the earnings sweep pays only sales made
-- on or after a start time. Additive only: one new table with one row.
--
-- The row is written here, so the start time is the moment this code reaches
-- an environment (the ruling's default), stored once. A sale completed before
-- it is never paid by the sweep; admins list those for review. The setting
-- EARNINGS_SWEEP_START, when set, takes the place of the stored time.
CREATE TABLE "EarningSweepStart" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EarningSweepStart_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "EarningSweepStart"
    ADD CONSTRAINT "EarningSweepStart_one_row" CHECK ("id" = 1);

INSERT INTO "EarningSweepStart" ("id", "startedAt")
VALUES (1, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
