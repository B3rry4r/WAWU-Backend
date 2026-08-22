-- COMMUNITY HOSTS CAN NOW ACTUALLY BE PAID.
--
-- docs/01_SPEC.md §1 row 4 sells WAWU Credits at "Creator 90% / WAWU 10%",
-- and §3 says that split is "deliberately a better split than every other
-- stream, not an error". Six live app surfaces repeat it verbatim ("you keep
-- 90% of every credit spent in it"). Nothing in this backend could pay it:
-- CreditSpend stored a credit COUNT and no money at all, and
-- creator-earnings.service.ts explicitly excluded credits from `total`,
-- `payable` and `held`. A host could run a busy community for a year and
-- earn nothing. Law 12 — sold is built.
--
-- THE MODELLING PROBLEM. A credit is bought in a pack and spent one at a
-- time, possibly months later. The three packs are not the same price per
-- credit: ₦500/50 = ₦10.00, ₦1,000/120 = ₦8.33…, ₦2,000/300 = ₦6.66…. So
-- "what is a credit worth" has no platform-wide answer. A single blended
-- rate would let WAWU owe a host 90% of ₦10 for a credit it sold for ₦6.67
-- — i.e. a 135% payout on that credit — which contradicts the very split it
-- was meant to implement.
--
-- THE MODEL: PER-PACK COST BASIS, CONSUMED FIFO.
--   * Every completed CreditPurchase opens a CreditLot carrying the exact
--     kobo WAWU banked and the credits it bought.
--   * A spend draws credits from the oldest open lot first, and carries that
--     lot's real cost basis onto the spend.
--   * The host earns 90% of that, floored to the kobo; the residual kobo
--     stays with WAWU, so a payout can never exceed what was collected.
-- Full reasoning: src/credit-spend/credit-spend.service.ts (doc comment
-- "THE COST-BASIS MODEL").
--
-- ADDITIVE ONLY. Two new tables; no column added to CreditSpend,
-- CreditPurchase or CreditsState. That is deliberate: most wire types in
-- this backend are bare Prisma re-exports returned by spread, so a new
-- column on an existing table silently widens a live app response. Neither
-- new table is a wire type, and neither is reachable from any endpoint.
--
-- NOT A WALLET. CLAUDE.md is absolute: no cash balance, no cash-out, and a
-- member's credits render as a COUNT forever. This is a host EARNINGS
-- ledger — the same category as Purchase.amount minus commission — and it
-- changes nothing about what a member sees.

CREATE TABLE "CreditLot" (
    "id" TEXT NOT NULL,
    "creditPurchaseId" TEXT NOT NULL,
    "userWawuId" TEXT NOT NULL,
    "creditsGranted" INTEGER NOT NULL,
    "creditsRemaining" INTEGER NOT NULL,
    "grossKobo" INTEGER NOT NULL,
    "allocatedKobo" INTEGER NOT NULL DEFAULT 0,
    "purchasedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditLot_pkey" PRIMARY KEY ("id")
);

-- The idempotency key. Verification is claim-guarded in application code,
-- but this is the constraint that makes a double-verify structurally unable
-- to mint a second lot (and therefore free host earnings) even if that guard
-- were ever removed.
CREATE UNIQUE INDEX "CreditLot_creditPurchaseId_key" ON "CreditLot"("creditPurchaseId");

-- FIFO consumption reads exactly this: open lots for one user, oldest first.
CREATE INDEX "CreditLot_userWawuId_purchasedAt_idx" ON "CreditLot"("userWawuId", "purchasedAt");

ALTER TABLE "CreditLot" ADD CONSTRAINT "CreditLot_creditPurchaseId_fkey"
    FOREIGN KEY ("creditPurchaseId") REFERENCES "CreditPurchase"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Guard rails the application maths already respects, enforced by the
-- database so a future writer cannot quietly break the invariant that makes
-- this safe: a lot can never allocate more money than was collected for it,
-- and can never hand out more credits than it granted.
ALTER TABLE "CreditLot" ADD CONSTRAINT "CreditLot_allocated_within_gross"
    CHECK ("allocatedKobo" >= 0 AND "allocatedKobo" <= "grossKobo");
ALTER TABLE "CreditLot" ADD CONSTRAINT "CreditLot_remaining_within_granted"
    CHECK ("creditsRemaining" >= 0 AND "creditsRemaining" <= "creditsGranted");

CREATE TABLE "CreditSpendEarning" (
    "id" TEXT NOT NULL,
    "creditSpendId" TEXT NOT NULL,
    "creatorWawuId" TEXT NOT NULL,
    "communityId" TEXT NOT NULL,
    "creditsSpent" INTEGER NOT NULL,
    "creditsFunded" INTEGER NOT NULL,
    "grossKobo" INTEGER NOT NULL,
    "hostShareKobo" INTEGER NOT NULL,
    "platformShareKobo" INTEGER NOT NULL,
    "lotIds" TEXT[],
    "earnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditSpendEarning_pkey" PRIMARY KEY ("id")
);

-- One earning per spend, forever. Replaying a spend cannot pay a host twice.
CREATE UNIQUE INDEX "CreditSpendEarning_creditSpendId_key" ON "CreditSpendEarning"("creditSpendId");
CREATE INDEX "CreditSpendEarning_creatorWawuId_idx" ON "CreditSpendEarning"("creatorWawuId");
CREATE INDEX "CreditSpendEarning_creatorWawuId_earnedAt_idx" ON "CreditSpendEarning"("creatorWawuId", "earnedAt");

-- Cascade so the existing contract suites, which clean up by deleting the
-- CreditSpend rows they created, do not leave orphaned earnings behind that
-- would inflate the next run's totals (law 16: a suite restores what it
-- mutates).
ALTER TABLE "CreditSpendEarning" ADD CONSTRAINT "CreditSpendEarning_creditSpendId_fkey"
    FOREIGN KEY ("creditSpendId") REFERENCES "CreditSpend"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- The split, enforced in the database. 90/10 exactly, with the floored
-- residual kobo going to WAWU — never to the host, so the platform can never
-- pay out more than it banked.
ALTER TABLE "CreditSpendEarning" ADD CONSTRAINT "CreditSpendEarning_shares_sum_to_gross"
    CHECK ("hostShareKobo" >= 0
       AND "platformShareKobo" >= 0
       AND "hostShareKobo" + "platformShareKobo" = "grossKobo");
ALTER TABLE "CreditSpendEarning" ADD CONSTRAINT "CreditSpendEarning_funded_within_spent"
    CHECK ("creditsFunded" >= 0 AND "creditsFunded" <= "creditsSpent");

-- BACKFILL, and what it deliberately does not do.
--
-- Every already-completed CreditPurchase opens a lot for the credits it
-- bought. `creditsRemaining` is seeded to the credits NOT yet accounted for
-- by that buyer's historical spends, FIFO — so a buyer who already spent 60
-- of a 120-pack opens with 60 remaining and the corresponding kobo already
-- marked allocated. Without this, every historical credit would be re-issued
-- as spendable cost basis and hosts would be paid twice for the same money.
--
-- It does NOT retro-create CreditSpendEarning rows for historical spends.
-- Those spends were never attributed to a lot at the time, the FIFO order
-- across interleaved purchases and spends is not reliably recoverable from
-- timestamps alone, and inventing host earnings for them would put naira in
-- the ledger that no reconciliation could defend. Historical spends stay
-- visible as a credit COUNT (unchanged) and earn ₦0. This backend has no
-- production traffic yet; the honest zero costs nobody anything real, and a
-- guessed number would be in the books forever.
INSERT INTO "CreditLot" (
    "id", "creditPurchaseId", "userWawuId", "creditsGranted",
    "creditsRemaining", "grossKobo", "allocatedKobo", "purchasedAt"
)
SELECT
    gen_random_uuid()::text,
    p."id",
    p."userWawuId",
    p."creditsGranted",
    -- Credits of THIS lot left over after this buyer's total historical
    -- spend has eaten through the lots older than it, FIFO.
    GREATEST(0, LEAST(
        p."creditsGranted",
        p."creditsGranted" + COALESCE(older."creditsBefore", 0) - COALESCE(spent."total", 0)
    )),
    p."amount" * 100,
    -- Kobo already consumed = the largest-remainder allocation for the
    -- credits already eaten out of this lot. Identical formula to
    -- CreditSpendService.allocate(), so the running invariant holds from the
    -- first post-migration spend onwards.
    FLOOR(
        (p."amount" * 100)::numeric
        * (p."creditsGranted" - GREATEST(0, LEAST(
              p."creditsGranted",
              p."creditsGranted" + COALESCE(older."creditsBefore", 0) - COALESCE(spent."total", 0)
          )))::numeric
        / p."creditsGranted"::numeric
    )::int,
    p."purchasedAt"
FROM "CreditPurchase" p
LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(o."creditsGranted"), 0) AS "creditsBefore"
    FROM "CreditPurchase" o
    WHERE o."userWawuId" = p."userWawuId"
      AND o."status" = 'completed'
      AND (o."purchasedAt", o."id") < (p."purchasedAt", p."id")
) older ON TRUE
LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(s."creditsSpent"), 0) AS "total"
    FROM "CreditSpend" s
    WHERE s."userWawuId" = p."userWawuId"
) spent ON TRUE
WHERE p."status" = 'completed';
