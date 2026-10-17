import type { Prisma } from '../../../generated/prisma/client';
import type { PrismaService } from '../../common/prisma/prisma.service';
import type { WalletHoldService } from '../holds/wallet-hold.service';
import type { CompletedPayment } from './payable-registry';

/**
 * Deliver what a payment paid for, or pay it back (bundle B1: tips, unlocks
 * and legal fees; the same shape as TIER-03's refund of a plan that cannot be
 * granted).
 *
 * A feature's `onCompleted` runs once the provider has confirmed the debit,
 * in the request and again from the payment sweep, on any server. Two things
 * can be true of one payment and never both: it was delivered, or its price
 * is going back to the payer. This decides between them in ONE short
 * database-only transaction that holds the payment's row (`FOR UPDATE`), so
 * two servers cannot split the decision:
 *
 * - a refund already decided (the payment's hold exists) stays decided, and
 *   nothing is delivered;
 * - otherwise the feature's `refusal` reads the world (the creator is gone,
 *   the piece was removed, the request was cancelled) and answers why the
 *   payment cannot be delivered, or null when it can; `grant` then writes
 *   what was paid for, idempotently;
 * - a refusal writes the payment's hold (an ordinary kind has none) and asks
 *   MONEY-18's refund, AFTER the transaction and holding nothing, so no
 *   transaction or connection is open across the provider call. The refund is
 *   asked under one reference of ours that the provider refuses to repeat.
 *
 * The provider's charge on the original payment is not returned (R-10). The
 * payment keeps no earning: the sweep never adopts a payment that has a hold.
 */
export interface DeliverOrRefund<G> {
  /** The hold's `releaseCondition` for a payment that is being paid back. */
  condition: string;
  /** Why this payment cannot be delivered, or null when it can. Reads only. */
  refusal(tx: Prisma.TransactionClient): Promise<string | null>;
  /** Writes what was paid for, once. Returns what the caller needs to know (was it new). */
  grant(tx: Prisma.TransactionClient): Promise<G>;
}

export type DeliveryOutcome<G> =
  | { outcome: 'granted'; granted: G }
  | { outcome: 'refund'; why: string };

export async function deliverOrRefund<G>(
  prisma: PrismaService,
  holds: Pick<WalletHoldService, 'refund'>,
  payment: Pick<CompletedPayment, 'paymentId'>,
  rule: DeliverOrRefund<G>,
): Promise<DeliveryOutcome<G>> {
  const decided = await prisma.$transaction(
    async (tx): Promise<DeliveryOutcome<G>> => {
      await tx.$queryRaw`SELECT "id" FROM "WalletPayment" WHERE "id" = ${payment.paymentId} FOR UPDATE`;
      const existing = await tx.walletHold.findUnique({
        where: { paymentId: payment.paymentId },
        select: { action: true },
      });
      if (existing) return { outcome: 'refund', why: 'already decided' };
      const why = await rule.refusal(tx);
      if (why === null) {
        return { outcome: 'granted', granted: await rule.grant(tx) };
      }
      const p = await tx.walletPayment.findUniqueOrThrow({
        where: { id: payment.paymentId },
      });
      await tx.walletHold.createMany({
        data: [
          {
            paymentId: p.id,
            payerWawuUserId: p.payerWawuUserId,
            payeeWawuUserId: null,
            kind: p.kind,
            targetId: p.targetId,
            title: p.title,
            releaseCondition: rule.condition,
            amountKobo: p.priceKobo,
            payeeShareKobo: p.payeeShareKobo,
            wawuShareKobo: p.wawuShareKobo,
            merchantAccountNumber: p.merchantAccountNumber,
            provider: p.provider,
            heldAt: new Date(),
          },
        ],
        skipDuplicates: true,
      });
      return { outcome: 'refund', why };
    },
  );
  if (decided.outcome === 'refund') {
    await holds.refund(
      { paymentId: payment.paymentId },
      `not delivered: ${decided.why}`.slice(0, 200),
    );
  }
  return decided;
}
