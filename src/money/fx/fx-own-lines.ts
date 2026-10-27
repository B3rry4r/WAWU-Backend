import type { PrismaService } from '../../common/prisma/prisma.service';
import {
  CATEGORY_LABELS,
  COUNTERPARTY_FALLBACK_NAMES,
  DESCRIPTION_SEPARATOR,
  LINK_KIND_LABELS,
} from '../history/history-labels';
import type { FxTransactionView } from './fx-view.type';

/**
 * Lines WAWU made on a person's foreign account (FIX-P6 L2, R-91): a payment
 * for a naira price, WAWU's conversion fee on it, and a refund back to the
 * account. The provider's statement names the other side of such a line by
 * WAWU's own internal account ("WAWU operational (held money)"), and a person
 * never reads WAWU's internal account names. So these lines are named the way
 * the naira history names the same movement (history-labels.ts): "Who Made
 * This" as the other side, then what it was for ("Unlock · the piece's
 * title"), from WAWU's own records of the payment or the hold. A line whose
 * record cannot be found (or is another person's) is still named plainly
 * ("Payment", "Refund", "Conversion fee"), never by the provider's account.
 *
 * Money from a person, a swap and a send keep what the provider says: the
 * other side there is a person, not WAWU.
 */

/**
 * Our references (payments `wawu-pay-<id>`, holds `wawu-rel-<id>` and `wawu-ref-<id>`, a number after a proven failure), as the
 * provider's statement echoes them: on its own, with the provider's receiving-side prefix, or with a fee leg's suffix.
 */
const OURS =
  /wawu-(?:pay|ref|rel)-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?:-\d+)?/i;
const FEE_SUFFIX = '-fee';

export const FEE_LABEL = 'Conversion fee';

type Part = 'payment' | 'refund' | 'release' | 'fee';

/** What the provider calls the moves WAWU makes (the narrations in payment-fx.service.ts and hold-rules.ts). */
const NARRATIONS: Record<string, Part> = {
  'wawu purchase': 'payment',
  'wawu refund': 'refund',
  'wawu fee': 'fee',
  'wawu earning': 'release',
};

interface Kept {
  kind: string;
  title: string;
}

/** Our reference inside a statement reference, and whether the line is the fee leg of it. */
function ours(reference: string): { base: string; fee: boolean } {
  const found = OURS.exec(reference);
  if (!found) return { base: reference.trim(), fee: false };
  const rest = reference.slice(found.index + found[0].length);
  return { base: found[0], fee: rest.startsWith(FEE_SUFFIX) };
}

function partOf(
  reference: string,
  description: string,
  transfers: ReadonlyMap<string, Part>,
  id: string,
): { part: Part; base: string } | null {
  const { base, fee } = ours(reference);
  const known = transfers.get(id);
  if (base.startsWith('wawu-pay-')) {
    return { part: fee ? 'fee' : 'payment', base };
  }
  if (base.startsWith('wawu-ref-')) return { part: 'refund', base };
  if (base.startsWith('wawu-rel-')) return { part: 'release', base };
  // The transfer id our own record of the payment holds: the statement's line id is the provider's transfer id.
  if (known) return { part: known, base };
  const narrated = NARRATIONS[description.trim().toLowerCase()];
  return narrated ? { part: narrated, base } : null;
}

function wordsOf(part: Part, kept: Kept | undefined): string {
  const label =
    part === 'fee'
      ? FEE_LABEL
      : part === 'refund'
        ? CATEGORY_LABELS.refund
        : part === 'release'
          ? CATEGORY_LABELS.earning
          : ((kept &&
              (LINK_KIND_LABELS as Record<string, string | undefined>)[
                kept.kind
              ]) ??
            CATEGORY_LABELS.purchase);
  // A refund of a payment says what it was for the way a payment does: "Refund · the title".
  return [label, kept?.title.trim()]
    .filter((p): p is string => !!p)
    .join(DESCRIPTION_SEPARATOR);
}

/**
 * Names the lines of one page of an account's history that WAWU made, in
 * place. `owner` is the account's own person: only their payments and holds
 * are read, so a title is never another person's.
 */
export async function nameOwnLines(
  prisma: PrismaService,
  owner: { wawuUserId: string; fxAccountId: string },
  lines: FxTransactionView[],
): Promise<void> {
  if (lines.length === 0) return;
  const bases = [
    ...new Set(
      lines
        .map((l) => ours(l.reference).base)
        .filter((b) => /^wawu-(pay|ref|rel)-/.test(b)),
    ),
  ];
  const ids = lines.map((l) => l.id);
  const [payments, holds, moves] = await Promise.all([
    bases.length
      ? prisma.walletPayment.findMany({
          where: {
            customerReference: { in: bases },
            payerWawuUserId: owner.wawuUserId,
          },
          select: { customerReference: true, kind: true, title: true },
        })
      : [],
    bases.length
      ? prisma.walletHold.findMany({
          where: {
            customerReference: { in: bases },
            payerWawuUserId: owner.wawuUserId,
          },
          select: { customerReference: true, kind: true, title: true },
        })
      : [],
    prisma.walletPaymentFx.findMany({
      where: {
        fxAccountId: owner.fxAccountId,
        OR: [
          { providerTransferId: { in: ids } },
          { refundTransferId: { in: ids } },
        ],
        payment: { payerWawuUserId: owner.wawuUserId },
      },
      select: {
        providerTransferId: true,
        refundTransferId: true,
        payment: { select: { kind: true, title: true } },
      },
    }),
  ]);
  const byReference = new Map<string, Kept>();
  for (const p of [...payments, ...holds]) {
    if (p.customerReference) {
      byReference.set(p.customerReference, { kind: p.kind, title: p.title });
    }
  }
  const transfers = new Map<string, Part>();
  const byTransfer = new Map<string, Kept>();
  for (const m of moves) {
    if (m.providerTransferId) {
      transfers.set(m.providerTransferId, 'payment');
      byTransfer.set(m.providerTransferId, m.payment);
    }
    if (m.refundTransferId) {
      transfers.set(m.refundTransferId, 'refund');
      byTransfer.set(m.refundTransferId, m.payment);
    }
  }
  for (const line of lines) {
    const found = partOf(line.reference, line.description, transfers, line.id);
    if (!found) continue;
    const kept = byReference.get(found.base) ?? byTransfer.get(line.id);
    line.counterpartyName = COUNTERPARTY_FALLBACK_NAMES.wawu;
    line.description = wordsOf(found.part, kept);
    // A payment is not a swap the person made: no rate line stands in for what it paid for.
    if (found.part === 'payment') line.conversion = null;
  }
}
