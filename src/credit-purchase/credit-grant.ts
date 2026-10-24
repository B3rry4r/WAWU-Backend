import type { Prisma } from '../../generated/prisma/client';

/**
 * THE one place a bought pack of WAWU Credits is added to a balance (shared by
 * the wallet payment, INBOX-16, and the app-store purchase, IAP-01): the
 * balance and the cost-basis lot are written together, in the caller's
 * transaction, because a balance credited without its lot would be spendable
 * credits with no cost basis, and the community host would earn nothing on
 * money WAWU banked.
 *
 * `grossKobo` is what WAWU actually collected for the pack: the pack's price
 * for the wallet, and the price less the store's share for a store purchase
 * (R-86), so the host's 85% is worked on what WAWU received.
 *
 * The caller has already written the `CreditPurchase` row (its unique key is
 * the once-only gate) and passes its id and date. Idempotent on the lot: the
 * lot's `creditPurchaseId` is unique, so a repeat writes no second lot.
 */
export async function addCreditsWithLot(
  tx: Prisma.TransactionClient,
  grant: {
    userWawuId: string;
    credits: number;
    grossKobo: number;
    purchaseId: string;
    purchasedAt: Date;
  },
): Promise<void> {
  await tx.creditsState.upsert({
    where: { userWawuId: grant.userWawuId },
    create: { userWawuId: grant.userWawuId, creditBalance: grant.credits },
    update: { creditBalance: { increment: grant.credits } },
  });
  await tx.creditLot.createMany({
    data: [
      {
        creditPurchaseId: grant.purchaseId,
        userWawuId: grant.userWawuId,
        creditsGranted: grant.credits,
        creditsRemaining: grant.credits,
        grossKobo: grant.grossKobo,
        allocatedKobo: 0,
        purchasedAt: grant.purchasedAt,
      },
    ],
    skipDuplicates: true,
  });
}
