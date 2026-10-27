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
 * title"), from WAWU's own records of the payment or the hold. A line of
 * WAWU's own whose record cannot be found (or is another person's) is still
 * named plainly ("Payment", "Refund", "Conversion fee"), never by the
 * provider's account.
 *
 * What a stranger controls is never trusted (round 2). Money from a person
 * (its name, its narration and its reference are theirs to write), a swap, a
 * send abroad and everything else that is not WAWU's own account keep what the
 * provider says. A line is WAWU's own only when
 *   - its transfer id is one our own payment record holds (a stranger cannot
 *     choose it), in the direction of that move; or
 *   - its reference is, in the exact format WAWU writes, of the matching
 *     direction (`wawu-pay-<id>` and its `-fee` are debits, `wawu-ref-<id>` is
 *     a credit), and the other side is WAWU's own account; or
 *   - its narration is ours, of the matching direction, and the other side is
 *     WAWU's own account; or
 *   - (last resort) the other side is WAWU's own account by name, whatever the
 *     line says: it is named by its direction, and nothing more.
 * "WAWU's own account" is a name this file knows (below), or the operational
 * account's own display name as the provider reads it.
 */

export const FEE_LABEL = 'Conversion fee';

/**
 * What WAWU's own accounts are called, as the code that makes and reads them
 * says: the operational account's fallback name in the Nuvion adapter
 * (`getPlatformAccount`, src/nuvion/areas/book.ts) and its stand-in's, WAWU's
 * fee collector (the stand-in's `WAWU collector`) and the merchant wallet of
 * R-19. Compared whole, ignoring
 * case, spaces and a bracketed ending ("(held money)"), so "WAWU Operational
 * (held money)" is the operational account while "WAWU USD 1a2b3c4d", the name
 * WAWU gives a person's own account (fx-accounts.service.ts), is not.
 */
const WAWU_ACCOUNT_NAMES = [
  'wawu',
  'wawu operational',
  'wawu collector',
  'wawu merchant',
];

/** A name, as it is compared: lower case, brackets and their words taken off, spaces collapsed. */
function plain(text: string | null | undefined): string {
  return (text ?? '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Says whether a name is one of WAWU's own accounts (`is`), and whether a line of words mentions one ("Book transfer to WAWU
 * operational"; only the names of two words or more are looked for inside words, so the bare "WAWU" of a narration such as
 * "WAWU swap" mentions nothing). `operational` is the operational account's display name as the provider reads it.
 */
export function ownAccountNamer(operational: readonly string[]): {
  is: (name: string | null | undefined) => boolean;
  mentions: (words: string | null | undefined) => boolean;
} {
  const names = [
    ...new Set(
      [...WAWU_ACCOUNT_NAMES, ...operational.map(plain)].filter(Boolean),
    ),
  ];
  const inside = names
    .filter((n) => n.includes(' '))
    .map(
      (n) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`),
    );
  const is = (name: string | null | undefined) => {
    const p = plain(name);
    return p !== '' && names.includes(p);
  };
  return {
    is,
    mentions: (words) => {
      const p = plain(words);
      return p !== '' && (is(words) || inside.some((re) => re.test(p)));
    },
  };
}

const UUID = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
/** The references WAWU writes, whole and nothing around them (a payment's debit, its fee leg, a hold's refund as the provider echoes it to the receiver). */
const PAYMENT = new RegExp(`^wawu-pay-(${UUID})$`, 'i');
const PAYMENT_FEE = new RegExp(`^wawu-pay-(${UUID})-fee$`, 'i');
const REFUND = new RegExp(
  `^(?:book-transfer-inflow-for-)?(wawu-ref-${UUID}(?:-\\d+)?)$`,
  'i',
);
/** WAWU's other moves (a swap `wawu-fx-`, a send abroad `wawu-abroad-`, a send `wawu-send-`, a bank send `wawu-bank-`): their lines keep the provider's words, with WAWU's account hidden. */
const OTHER_WAWU =
  /^(?:book-transfer-inflow-for-)?wawu-(?:fx|abroad|send|bank)-/i;

/** What the provider's narration says of a move WAWU made (payment-fx.service.ts, hold-rules.ts). */
const PURCHASE_NARRATION = 'wawu purchase';
const REFUND_NARRATION = 'wawu refund';
const FEE_NARRATION = 'wawu fee';

type Part = 'payment' | 'refund' | 'fee';
const DIRECTION: Record<Part, 'in' | 'out'> = {
  payment: 'out',
  fee: 'out',
  refund: 'in',
};

interface Kept {
  kind: string;
  title: string;
}

function wordsOf(part: Part, kept: Kept | undefined): string {
  const label =
    part === 'fee'
      ? FEE_LABEL
      : part === 'refund'
        ? CATEGORY_LABELS.refund
        : ((kept &&
            (LINK_KIND_LABELS as Record<string, string | undefined>)[
              kept.kind
            ]) ??
          CATEGORY_LABELS.purchase);
  return [label, kept?.title.trim()]
    .filter((p): p is string => !!p)
    .join(DESCRIPTION_SEPARATOR);
}

/** The last-resort word of a line that is WAWU's own and nothing more is known of: its direction. */
function directionWord(line: FxTransactionView): string {
  if (line.direction === 'in') return CATEGORY_LABELS.refund;
  return plain(line.description) === FEE_NARRATION
    ? FEE_LABEL
    : CATEGORY_LABELS.purchase;
}

/**
 * Names the lines of one page of an account's history that WAWU made, in
 * place. `owner` is the account's own person: only their payments and holds
 * are read, so a title is never another person's. `operational` is the
 * operational account's display name as the provider reads it (empty when it
 * could not say). Nothing but the two words of a line (`counterpartyName`,
 * `description`) is ever changed: its figures, time, status, reference and
 * rate block stay as the provider sent them.
 */
export async function nameOwnLines(
  prisma: PrismaService,
  owner: { wawuUserId: string; fxAccountId: string },
  lines: FxTransactionView[],
  operational: readonly string[] = [],
): Promise<void> {
  if (lines.length === 0) return;
  const namer = ownAccountNamer(operational);
  const isOwn = namer.is;

  // The records the lines may be ours by: payments and holds by our reference, payments by the provider's transfer id.
  const bases = new Set<string>();
  for (const l of lines) {
    const ref = l.reference.trim();
    const m = PAYMENT.exec(ref) ?? PAYMENT_FEE.exec(ref);
    if (m) bases.add(`wawu-pay-${m[1]}`);
    const r = REFUND.exec(ref);
    if (r) bases.add(r[1]);
  }
  const ids = lines.map((l) => l.id);
  const [payments, holds, moves] = await Promise.all([
    bases.size
      ? prisma.walletPayment.findMany({
          where: {
            customerReference: { in: [...bases] },
            payerWawuUserId: owner.wawuUserId,
          },
          select: { customerReference: true, kind: true, title: true },
        })
      : [],
    bases.size
      ? prisma.walletHold.findMany({
          where: {
            customerReference: { in: [...bases] },
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
  const byDebit = new Map<string, Kept>();
  const byRefund = new Map<string, Kept>();
  for (const m of moves) {
    if (m.providerTransferId) byDebit.set(m.providerTransferId, m.payment);
    if (m.refundTransferId) byRefund.set(m.refundTransferId, m.payment);
  }

  const say = (line: FxTransactionView, description: string) => {
    line.counterpartyName = COUNTERPARTY_FALLBACK_NAMES.wawu;
    line.description = description;
  };

  for (const line of lines) {
    const ref = line.reference.trim();
    const own = isOwn(line.counterpartyName);
    // The other side is not a person: WAWU's own account, or one the provider names nobody on.
    const notAPerson = own || line.counterpartyName === null;

    // 1. The provider's transfer id is one of our own records' (a stranger cannot choose it), in the direction of that move.
    const byId =
      line.direction === 'out' ? byDebit.get(line.id) : byRefund.get(line.id);
    if (byId) {
      say(line, wordsOf(line.direction === 'out' ? 'payment' : 'refund', byId));
      continue;
    }

    // 2. Our reference, whole, in the direction it is written for, with WAWU's own account on the other side.
    let part: Part | null = null;
    let base = '';
    const pay = PAYMENT.exec(ref);
    const fee = PAYMENT_FEE.exec(ref);
    const back = REFUND.exec(ref);
    if (pay) {
      part = 'payment';
      base = `wawu-pay-${pay[1]}`;
    } else if (fee) {
      part = 'fee';
      base = `wawu-pay-${fee[1]}`;
    } else if (back) {
      part = 'refund';
      base = back[1];
    }
    if (part && line.direction === DIRECTION[part] && notAPerson) {
      const kept = byReference.get(base);
      // Without a record the line is still WAWU's own only if the provider says whose it is.
      if (kept || own) {
        say(line, wordsOf(part, kept));
        continue;
      }
    }

    // 3. Our narration, in the direction it is written for, with WAWU's own account on the other side. A fee's narration is also
    // a swap's and a send's, so it names nothing here: only a payment's own fee reference does (above).
    if (own && !OTHER_WAWU.test(ref)) {
      const narration = plain(line.description);
      if (
        (narration === PURCHASE_NARRATION && line.direction === 'out') ||
        (narration === REFUND_NARRATION && line.direction === 'in')
      ) {
        say(line, directionWord(line));
        continue;
      }
    }

    // 4. Last resort: the other side is WAWU's own account, or the provider named none and the line says so. Nothing is known of
    // what it was for, so it says its direction; WAWU's other moves (a swap's or a send's fee) keep the provider's own description.
    if (
      own ||
      (line.counterpartyName === null && namer.mentions(line.description))
    ) {
      const keep = OTHER_WAWU.test(ref) && !namer.mentions(line.description);
      say(line, keep ? line.description : directionWord(line));
    }
  }
}
