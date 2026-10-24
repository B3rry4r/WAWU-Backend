import type { CapitalOrder as OrderRow } from '../../generated/prisma/client';
import type {
  CapitalAccount,
  CapitalProduct,
  CapitalQuote,
} from '../wallet-provider/wallet-provider-capital';
import type {
  CapitalDeductibleView,
  CapitalHoldingView,
  CapitalOrderStatus,
  CapitalOrderView,
  CapitalProductView,
  CapitalQuoteView,
  CapitalWithdrawBlock,
} from './capital-view.type';

/** What a row keeps of the provider's side, as JSON. */
export interface CapitalSnapshot {
  quote: CapitalQuote | null;
  account: CapitalAccount | null;
}

export function readSnapshot(row: Pick<OrderRow, 'snapshot'>): CapitalSnapshot {
  const raw = row.snapshot;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { quote: null, account: null };
  }
  const o = raw as Record<string, unknown>;
  return {
    quote: (o.quote as CapitalQuote | null | undefined) ?? null,
    account: (o.account as CapitalAccount | null | undefined) ?? null,
  };
}

/** The local states that mean no money was taken and none will be. */
export const CAPITAL_ENDED_STATES = [
  'expired',
  'rejected',
  'cancelled',
  'failed',
] as const;

/** Provider holding states after which nothing more happens. */
const PAID_OUT = new Set(['WITHDRAWN', 'CLOSED', 'REFUNDED']);
const PAYING_OUT = new Set(['EARLY_LIQUIDATING', 'CLOSING']);

export function isTerminalLifecycle(lifecycle: string | null): boolean {
  return lifecycle !== null && PAID_OUT.has(lifecycle);
}

/** Where an order stands, in the one word the screen shows. */
export function statusOf(
  row: Pick<OrderRow, 'state' | 'expiresAt' | 'lifecycle'>,
  now: Date,
): CapitalOrderStatus {
  switch (row.state) {
    case 'reserving':
    case 'reserved':
      return row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()
        ? 'expired'
        : 'reserved';
    case 'confirming':
      return 'confirming';
    case 'expired':
    case 'rejected':
    case 'cancelled':
    case 'failed':
      return row.state;
    case 'review':
      return 'review';
    case 'confirmed': {
      const l = row.lifecycle;
      if (l === null) return 'invested';
      if (PAID_OUT.has(l)) return 'paid_out';
      if (PAYING_OUT.has(l)) return 'paying_out';
      if (l === 'MATURED') return 'matured';
      return 'invested';
    }
    default:
      return 'review';
  }
}

/**
 * Whether a withdrawal can be started, from the holding as last read. The
 * provider has the last word (it refuses with its own state check); this only
 * keeps a person from the PIN when the answer is already known.
 */
export function withdrawBlock(
  row: Pick<OrderRow, 'state' | 'lifecycle' | 'frozenAt' | 'productType'>,
  account: CapitalAccount | null,
  quote: CapitalQuote | null,
  now: Date,
): CapitalWithdrawBlock | null {
  if (row.state !== 'confirmed') return 'not_invested';
  if (row.productType !== 'FIXED_RETURN') return 'not_for_this_product';
  if (row.frozenAt !== null) return 'frozen';
  const l = row.lifecycle;
  if (l === 'MATURED') return null;
  // The money is already on its way out, or has been paid out.
  if (isTerminalLifecycle(l)) return 'not_invested';
  if (l !== 'ACTIVE' && l !== null) return 'in_progress';
  if (quote?.locked === true) return 'locked';
  if (quote?.allowEarlyWithdrawal === false) return 'not_allowed';
  const from = account?.earlyActionAt ?? null;
  if (account !== null && from === null) return 'not_allowed';
  if (from !== null && new Date(from).getTime() > now.getTime()) {
    return 'too_early';
  }
  if (
    account?.maturesAt &&
    new Date(account.maturesAt).getTime() <= now.getTime()
  ) {
    // At or after the date but still ACTIVE: the provider refuses until it
    // marks the holding matured (its own list of refusals says so).
    return 'in_progress';
  }
  return null;
}

function deductibleViews(
  list: readonly {
    name: string;
    value: number;
    valueType: 'flat' | 'percentage';
    appliesTo: 'principal' | 'interest';
  }[],
): CapitalDeductibleView[] {
  return list.map((d) => ({
    name: d.name,
    value: d.value,
    valueType: d.valueType,
    appliesTo: d.appliesTo,
  }));
}

export function quoteView(q: CapitalQuote | null): CapitalQuoteView | null {
  if (!q) return null;
  return {
    totalDebitKobo: q.totalDebitMinor,
    principalKobo: q.principalMinor,
    tenorDays: q.tenorDays,
    lockedRate: q.lockedRate,
    locked: q.locked,
    allowEarlyWithdrawal: q.allowEarlyWithdrawal,
    earliestWithdrawalDays: q.earliestWithdrawalDays,
    penaltyRate: q.penaltyRate,
    deductibles: deductibleViews(q.deductibles),
    requestedShares: q.requestedShares,
    allocatedShares: q.allocatedShares,
    unallocatedKobo: q.unallocatedMinor,
    offerPriceKobo: q.offerPriceMinor,
    baseCostKobo: q.baseCostMinor,
    brokerageFeeKobo: q.brokerageFeeMinor,
    crossDealFeeKobo: q.crossDealFeeMinor,
    lockPeriodDays: q.lockPeriodDays,
  };
}

function payoutStatusOf(
  v: string | null,
): 'pending' | 'completed' | 'failed' | null {
  return v === 'pending' || v === 'completed' || v === 'failed' ? v : null;
}

export function holdingView(
  a: CapitalAccount | null,
): CapitalHoldingView | null {
  if (!a) return null;
  return {
    numberLast4: a.numberLast4,
    lifecycle: a.lifecycle,
    payoutStatus: payoutStatusOf(a.payoutStatus),
    principalKobo: a.principalMinor,
    lockedRate: a.lockedRate,
    tenorDays: a.tenorDays,
    startedAt: a.startedAt,
    maturesAt: a.maturesAt,
    earlyExitFrom: a.earlyActionAt,
    accruedKobo: a.accruedMinor,
    expectedGrossInterestKobo: a.grossInterestMinor,
    expectedDeductionsKobo: a.totalDeductionsMinor,
    expectedPayoutKobo: a.expectedNetPayoutMinor,
    payoutKobo: a.netPayoutMinor,
    settlesAt: a.settlementAt,
    sharesPurchased: a.sharesPurchased,
    unitsHeld: a.unitsHeld,
    costKobo: a.baseCostMinor,
    lockEndsAt: a.lockExpiresAt,
    currentValueKobo: a.currentValueMinor,
    pendingRefundKobo: a.pendingRefundMinor,
  };
}

export function orderView(
  row: OrderRow,
  now: Date,
  note: string | null = null,
): CapitalOrderView {
  const snap = readSnapshot(row);
  const status = statusOf(row, now);
  const block = withdrawBlock(row, snap.account, snap.quote, now);
  const fee = Number(row.feeKobo);
  const debit =
    row.totalDebitMinor !== null
      ? Number(row.totalDebitMinor)
      : Number(row.amountMinor);
  return {
    id: row.id,
    status,
    productId: row.productId,
    productName: row.productName,
    kind:
      row.productType === 'SHARE_OFFERING' ? 'share_offering' : 'fixed_return',
    amountKobo: Number(row.amountMinor),
    quote: quoteView(snap.quote),
    feeKobo: fee,
    totalKobo: debit + fee,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    confirmedAt: row.confirmedAt ? row.confirmedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    frozen: row.frozenAt !== null,
    holding: holdingView(snap.account),
    canWithdraw:
      block === null && status !== 'paying_out' && status !== 'paid_out',
    withdrawBlockedBy: block,
    note,
  };
}

/** Why a share offering cannot be ordered now, from what the provider says. */
function notOrderable(
  p: CapitalProduct,
  now: Date,
): CapitalProductView['notOrderableReason'] {
  if (p.startsAt !== null && new Date(p.startsAt).getTime() > now.getTime()) {
    return 'not_open_yet';
  }
  if (p.endsAt !== null && new Date(p.endsAt).getTime() < now.getTime()) {
    return 'sale_closed';
  }
  const a = p.availability;
  if (a) {
    if (a.status === 'sold_out') return 'sold_out';
    if (a.orderable === false) {
      return a.reason === 'sale_window_closed' ? 'sale_closed' : 'unavailable';
    }
  }
  return null;
}

export function productView(
  p: CapitalProduct,
  now: Date,
  withDocuments: boolean,
): CapitalProductView {
  const reason = notOrderable(p, now);
  // The best rate a band gives, so a list can say "up to"; the base stays `annualRate`.
  return {
    id: p.id,
    kind: p.type === 'SHARE_OFFERING' ? 'share_offering' : 'fixed_return',
    name: p.name,
    description: p.description,
    minKobo: p.minMinor,
    maxKobo: p.maxMinor,
    tenorDays: p.tenorDays,
    annualRate: p.annualRate,
    rateBands: p.rateBands.map((b) => ({
      name: b.name,
      rate: b.rate,
      minKobo: b.minMinor,
      maxKobo: b.maxMinor,
    })),
    allowEarlyWithdrawal: p.allowEarlyWithdrawal,
    earliestWithdrawalDays: p.earliestWithdrawalDays,
    deductibles: deductibleViews(p.deductibles),
    opensAt: p.startsAt,
    closesAt: p.endsAt,
    issuerName: p.share?.issuerName ?? null,
    offerPriceKobo: p.share?.offerPriceMinor ?? null,
    lockPeriodDays: p.share?.lockPeriodDays ?? null,
    orderable: reason === null,
    notOrderableReason: reason,
    documents: withDocuments
      ? p.documents.map((d) => ({ name: d.name, url: d.url }))
      : [],
  };
}
