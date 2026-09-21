import type {
  AdminFinanceStream,
  AdminFinanceTxStatus,
} from './admin-finance-view.type';

/**
 * WAWU's cut: 15%, leaving the creator 85%.
 *
 * Declared here rather than imported from one of the five services that
 * already declare it, following this codebase's established per-resource
 * scope rule (src/purchase, src/content-piece, src/creator-earnings,
 * src/event-ticketing and src/wallet each carry their own copy). It is a
 * READ of the same rule, never a second source of truth: every row that
 * carries a snapshotted rate is split by ITS OWN rate, and this constant is
 * used only where the source row has no rate column.
 */
export const STANDARD_COMMISSION_RATE = 0.15;

/**
 * Credits are 85/15 like everything else.
 *
 * `CreditSpendService` expresses the host's share as the integer fraction
 * 17/20 so its largest-remainder allocation stays exact. Same number,
 * written the way this file needs it.
 */
export const CREDITS_COMMISSION_RATE = 0.15;

/**
 * Splits a gross figure into WAWU's share and the creator's, in integer kobo.
 *
 * The rate is converted to BASIS POINTS first and the arithmetic done in
 * integers. `Math.floor(99900 * 0.85)` is a floating-point multiply whose
 * result can land a hair under the true value, and a floor over that is how a
 * payout quietly loses a kobo per row. `commissionRate` is a Decimal(5,4)
 * column, so four decimal places is the whole of its precision and basis
 * points lose nothing.
 *
 * The creator's share is FLOORED and WAWU takes the residual kobo, which is
 * the same direction `CreditSpendEarning` rounds: a payout can never exceed
 * what was actually banked. The two halves therefore always add back to
 * exactly `grossKobo`, with no kobo invented and none lost - which is what
 * makes the stream breakdown add up to the total it sits under.
 *
 * A `commissionRate` of 1 means there is no creator counterparty at all
 * (a verification tick, a shop order), so the creator share is zero rather
 * than a fabricated one.
 */
export function splitKobo(
  grossKobo: number,
  commissionRate: number,
): { wawuShareKobo: number; creatorShareKobo: number } {
  return splitKoboByBps(grossKobo, Math.round((1 - commissionRate) * 10_000));
}

/** The same split, given the creator's share already in basis points. */
export function splitKoboByBps(
  grossKobo: number,
  creatorBps: number,
): { wawuShareKobo: number; creatorShareKobo: number } {
  const creatorShareKobo = Math.floor((grossKobo * creatorBps) / 10_000);
  return { creatorShareKobo, wawuShareKobo: grossKobo - creatorShareKobo };
}

/** Whole naira to integer kobo. Every source amount column but the credit lots is whole naira. */
export function nairaToKobo(naira: number): number {
  return Math.round(naira) * 100;
}

/**
 * What each stream is, where its money is stored, and which of its own
 * statuses count as money the platform actually took.
 *
 * `countedStatuses` is reported on the wire, so a screen can state its own
 * basis without the reader having to trust that it matches the query. The
 * queries in AdminFinanceService are written from these same lists.
 */
interface StreamDefinition {
  label: string;
  /** Percent of gross the creator keeps. 0 where no creator is on the other side. */
  creatorSharePct: number;
  source: string;
  countedStatuses: string[];
}

export const STREAM_DEFINITIONS: Record<AdminFinanceStream, StreamDefinition> =
  {
    content: {
      label: 'Content unlocks',
      creatorSharePct: 85,
      source:
        'Purchase (type=content), split by each row’s snapshotted commissionRate',
      countedStatuses: ['completed'],
    },
    tips: {
      label: 'Tips',
      creatorSharePct: 85,
      source:
        'Purchase (type=tip), split by each row’s snapshotted commissionRate',
      countedStatuses: ['completed'],
    },
    dm: {
      label: 'Paid DMs',
      creatorSharePct: 85,
      source:
        'DirectMessage. A row only exists once its charge verified, so every row is settled money; refunded rows are money returned to the sender and count as nothing.',
      countedStatuses: ['awaiting_response', 'responded'],
    },
    credits: {
      label: 'WAWU Credits',
      creatorSharePct: 85,
      source:
        'CreditPurchase, the moment WAWU banks a pack. The host share is attributed later, per spent credit, against the lot that funded it - see creditsAttribution.',
      countedStatuses: ['completed'],
    },
    verification: {
      label: 'Verification ticks',
      creatorSharePct: 0,
      source:
        'VerificationPurchase. Paid to the platform for a tick, with no creator on the other side, so all of it is WAWU’s.',
      countedStatuses: ['completed'],
    },
    events: {
      label: 'Event tickets',
      creatorSharePct: 85,
      source: 'EventOrder, split by each row’s snapshotted commissionRate',
      countedStatuses: ['paid'],
    },
    shop: {
      label: 'Shop',
      creatorSharePct: 0,
      source:
        'ShopOrder. Products are WAWU’s own catalogue - Product carries no seller column - so all of it is WAWU’s.',
      countedStatuses: ['paid'],
    },
  };

/**
 * One vocabulary for six lifecycles.
 *
 * Every mapping below is total over its enum, so no source status can fall
 * through and be silently counted as revenue.
 */
export function normaliseTransactionStatus(
  stream: AdminFinanceStream,
  sourceStatus: string,
): AdminFinanceTxStatus {
  switch (stream) {
    case 'content':
    case 'tips':
    case 'credits':
    case 'verification':
      // TransactionStatus: pending | completed | failed
      return sourceStatus === 'completed'
        ? 'settled'
        : sourceStatus === 'failed'
          ? 'failed'
          : 'pending';
    case 'dm':
      // DmStatus: awaiting_response | responded | refunded. The row is only
      // written after the charge verified, so anything not refunded is money
      // WAWU holds.
      return sourceStatus === 'refunded' ? 'refunded' : 'settled';
    case 'events':
      // EventOrderStatus: pending | paid | refunded | failed
      return sourceStatus === 'paid'
        ? 'settled'
        : sourceStatus === 'refunded'
          ? 'refunded'
          : sourceStatus === 'failed'
            ? 'failed'
            : 'pending';
    case 'shop':
      // ShopOrderStatus: pending | paid | failed | cancelled | refunded
      return sourceStatus === 'paid'
        ? 'settled'
        : sourceStatus === 'refunded'
          ? 'refunded'
          : sourceStatus === 'cancelled'
            ? 'cancelled'
            : sourceStatus === 'failed'
              ? 'failed'
              : 'pending';
  }
}

/**
 * The calendar month the given instant falls in, as [from, to).
 *
 * UTC, because every timestamp in this database is stored in UTC and a
 * month boundary computed in the server's local zone would move the figures
 * depending on where the process happens to be deployed.
 */
export function currentCalendarMonth(now: Date): { from: Date; to: Date } {
  const from = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
  );
  const to = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0),
  );
  return { from, to };
}
