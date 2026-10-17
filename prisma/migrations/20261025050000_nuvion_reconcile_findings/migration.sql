-- NUV-08: what the reconciliation with Nuvion reports (fee differences, a
-- webhook subscription that is missing or could not be renewed, a sweep that
-- could not read everything). Additive only: one new table.

CREATE TABLE "NuvionReconcileFinding" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "settingKobo" BIGINT,
    "providerKobo" BIGINT,
    "amountKobo" BIGINT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "seenCount" INTEGER NOT NULL DEFAULT 1,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "NuvionReconcileFinding_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NuvionReconcileFinding_kind_subject_key" ON "NuvionReconcileFinding"("kind", "subject");

CREATE INDEX "NuvionReconcileFinding_resolvedAt_lastSeenAt_idx" ON "NuvionReconcileFinding"("resolvedAt", "lastSeenAt");
