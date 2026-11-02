import type { WalletCard } from '../../../generated/prisma/client';
import type { PrismaService } from '../../common/prisma/prisma.service';
import type { ProviderCard } from '../../wallet-provider/wallet-provider.interface';

/** What the row of a card can be after Nuvion has spoken. */
export type CardTarget =
  | { state: 'active'; frozenBy: null }
  | { state: 'frozen'; frozenBy: 'person' | 'admin' }
  | { state: 'used'; frozenBy: null };

/** A change to make, and the states it may start from. */
export type CardStep = CardTarget & { from: string[] };

/** The row states a card still follows Nuvion from. `used`, `cancelled` and `failed` never move. */
const LIVE_STATES = ['creating', 'unknown', 'active', 'frozen'];

/**
 * Where Nuvion's word puts a card (the card guide, "Card statuses", docs of
 * 29 Oct 2026; CARD-USE). One rule for every path that reads a card: the
 * webhook handler, the card screen and the adoption of a card whose answer was
 * lost.
 *
 * - `active`: in good standing.
 * - `blocked`: frozen or soft-deleted. A card that no longer reads at all is a
 *   404, which the caller turns into blocked for good. The same for a reusable
 *   card and a single-use one (the sandbox once answered `blocked` after a
 *   single-use payment; the docs say `deactivated`, and only that means used).
 * - `deactivated`: a single-use card that has taken its one payment is used.
 *   The docs describe no such status for a reusable card, so one that says it
 *   is held as support's: frozen, and the person cannot unfreeze it.
 * - `fraud`: flagged for suspected fraud; Nuvion's docs say to contact
 *   support. Frozen as support's, whatever the kind. Never used.
 */
export function cardTargetFor(
  row: Pick<WalletCard, 'type' | 'frozenBy'>,
  status: ProviderCard['status'],
): CardTarget {
  switch (status) {
    case 'active':
      return { state: 'active', frozenBy: null };
    case 'blocked':
      return {
        state: 'frozen',
        frozenBy: row.frozenBy === 'admin' ? 'admin' : 'person',
      };
    case 'fraud':
      return { state: 'frozen', frozenBy: 'admin' };
    case 'deactivated':
      return row.type === 'single_use'
        ? { state: 'used', frozenBy: null }
        : { state: 'frozen', frozenBy: 'admin' };
  }
}

/**
 * The change Nuvion's word makes to a row, or null when the row already says
 * it (or the row is one that never moves). `from` is where the write may start
 * from: a card that is used or held as support's wins over active or frozen,
 * so the write holds whichever of the two the row has become meanwhile; any
 * other change holds only the state it was decided from.
 */
export function cardStepFor(
  row: Pick<WalletCard, 'type' | 'state' | 'frozenBy'>,
  status: ProviderCard['status'],
): CardStep | null {
  if (!LIVE_STATES.includes(row.state)) return null;
  const to = cardTargetFor(row, status);
  if (to.state === row.state) {
    if (to.state !== 'frozen') return null;
    // Frozen already: only support's hold is news.
    if (to.frozenBy !== 'admin' || row.frozenBy === 'admin') return null;
  }
  const strong = to.state === 'used' || to.frozenBy === 'admin';
  return {
    ...to,
    from: strong ? [...new Set([row.state, 'active', 'frozen'])] : [row.state],
  };
}

/**
 * Makes a live row follow Nuvion's word for the card. Only the row changes:
 * no money moves, and only that row. The write holds the state it was decided
 * from, so a card the person blocked while Nuvion was being asked stays
 * blocked. Returns the step taken, or null when nothing changed.
 */
export async function followCardStatus(
  prisma: PrismaService,
  row: WalletCard,
  status: ProviderCard['status'],
): Promise<CardStep | null> {
  const step = cardStepFor(row, status);
  if (!step) return null;
  const done = await prisma.walletCard.updateMany({
    where: { id: row.id, state: { in: step.from } },
    data: { state: step.state, frozenBy: step.frozenBy },
  });
  return done.count === 1 ? step : null;
}

/** How a step reads in a log line: our words and fixed words only. */
export function stepWords(step: Pick<CardStep, 'state' | 'frozenBy'>): string {
  if (step.state === 'frozen' && step.frozenBy === 'admin') {
    return 'frozen as support';
  }
  return step.state;
}
