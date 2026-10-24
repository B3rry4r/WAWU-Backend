import { randomUUID } from 'node:crypto';
import {
  type CapitalAccount,
  type CapitalConfirmation,
  type CapitalListQuery,
  type CapitalOrder,
  type CapitalPage,
  type CapitalPortfolioLine,
  type CapitalProduct,
  type CapitalProductType,
  type CapitalQuote,
  type CapitalReservation,
  type CapitalTransaction,
  type CapitalWallet,
  type CapitalWithdrawalPreview,
  WalletProviderCapitalError,
  type WalletProviderCapital,
} from '../../src/wallet-provider/wallet-provider-capital';
import { WalletProviderError } from '../../src/wallet-provider/wallet-provider-error';
import type { NuvionSeamStandIn } from '../payments/nuvion-seam-standin';

/**
 * Nuvion's Capital at the seam (task NUV-12), for the Hub's own specs: the
 * answers are the shapes Nuvion's dev gave on 24 Oct 2026 (mobile
 * docs/nuvion/DEV-RESULTS.md, "Capital"), kept in memory, with the person's
 * money taken from and given back to the seam stand-in's accounts.
 *
 * What it does as dev did:
 * - a reservation lasts 15 minutes and moves nothing;
 * - `confirm` debits once; a second `confirm` of an order that is approved
 *   answers "can no longer be confirmed" (dev: 400 invalid for state), not
 *   the first result;
 * - the capital account's early action date is the confirmation moment, so a
 *   withdrawal is allowed at once; the payout is `EARLY_LIQUIDATING` until
 *   `settlePayouts()` (dev settled in seconds), then `WITHDRAWN` with the
 *   money back in the funding account.
 */

export const PRODUCT_FR = '01FRSEAM00000000000000001A';
export const PRODUCT_FR_LOCKED_ONLY = '01FRSEAM00000000000000002B';
export const PRODUCT_SO = '01SOSEAM00000000000000003C';
export const PRODUCT_SO_CLOSED = '01SOSEAM00000000000000004D';
export const PRODUCT_USD = '01USDSEAM0000000000000005E';

const DOCS = [
  {
    name: 'Terms & Conditions.pdf',
    url: 'https://docs.example.test/terms.pdf',
  },
];

function product(
  over: Partial<CapitalProduct> & { id: string },
): CapitalProduct {
  return {
    type: 'FIXED_RETURN',
    name: 'Product',
    currency: 'NGN',
    startsAt: null,
    endsAt: null,
    minMinor: 100_000,
    maxMinor: 100_000_000,
    tenorDays: 90,
    earliestWithdrawalDays: null,
    annualRate: 0.3,
    rateBands: [],
    allowEarlyWithdrawal: true,
    deductibles: [
      {
        name: 'Withholding Tax',
        value: 0.1,
        valueType: 'percentage',
        appliesTo: 'interest',
      },
    ],
    documents: DOCS,
    share: null,
    availability: null,
    ...over,
  };
}

export class CapitalSeamStandIn implements WalletProviderCapital {
  readonly currencies = ['NGN'];
  readonly calls: string[] = [];
  readonly products: CapitalProduct[] = [
    product({ id: PRODUCT_FR, name: '90 Days Treasury Bills' }),
    product({
      id: PRODUCT_FR_LOCKED_ONLY,
      name: '180 Days Fixed Income',
      tenorDays: 180,
      annualRate: 0.23,
      allowEarlyWithdrawal: false,
    }),
    product({
      id: PRODUCT_SO,
      type: 'SHARE_OFFERING',
      name: 'Dangote IPO SPV',
      minMinor: 20_000,
      maxMinor: 10_000_000,
      tenorDays: null,
      annualRate: null,
      allowEarlyWithdrawal: null,
      deductibles: [
        {
          name: 'Cross-Deal Fee',
          value: 0.01,
          valueType: 'percentage',
          appliesTo: 'principal',
        },
      ],
      share: {
        issuerName: 'Dangote Refinery',
        offerPriceMinor: 10_000,
        lockPeriodDays: 0,
        prospectusUrl: 'https://docs.example.test/prospectus.pdf',
        stage: 'ipo',
      },
      availability: {
        status: 'available',
        orderable: null,
        reason: null,
        quantity: null,
      },
    }),
    product({
      id: PRODUCT_SO_CLOSED,
      type: 'SHARE_OFFERING',
      name: 'MTN Public Offering',
      tenorDays: null,
      annualRate: null,
      allowEarlyWithdrawal: null,
      share: {
        issuerName: 'MTN',
        offerPriceMinor: 1000,
        lockPeriodDays: 180,
        prospectusUrl: null,
        stage: 'ipo',
      },
      availability: {
        status: 'available',
        orderable: false,
        reason: 'sale_window_closed',
        quantity: null,
      },
    }),
    product({
      id: PRODUCT_USD,
      name: 'Fixed Return in dollars',
      currency: 'USD',
    }),
  ];
  /** The orders, by the provider's id. */
  readonly orders = new Map<
    string,
    {
      order: CapitalOrder;
      quote: CapitalQuote;
      walletId: string;
      accountId: string;
      userCapitalAccountId: string;
    }
  >();
  /** Lose the answer of the next confirm after the money has moved. */
  loseNextConfirm = false;
  /** Refuse the next confirm as Nuvion does for a short balance. */
  shortNextConfirm = false;
  /** Make the provider unreachable for the next call. */
  downNext = false;
  /** What a reservation's time is: tests move it to expire one. */
  reservationMs = 15 * 60_000;

  constructor(private readonly seam: NuvionSeamStandIn) {}

  private down(op: string): void {
    if (this.downNext) {
      this.downNext = false;
      throw new WalletProviderError({
        kind: 'outcome_unknown',
        provider: 'nuvion',
        operation: op,
        recordMayExist: false,
        requestNotSent: true,
      });
    }
  }

  private log(call: string) {
    this.calls.push(call);
  }

  listProducts(
    _w: CapitalWallet,
    q: CapitalListQuery,
  ): Promise<CapitalPage<CapitalProduct>> {
    this.log('listProducts');
    this.down('list capital products');
    const items = this.products
      .filter((p) => this.currencies.includes(p.currency))
      .filter((p) => (q.type ? p.type === q.type : true))
      .map((p) => ({ ...p, documents: [] }));
    return Promise.resolve({ items, nextCursor: null });
  }

  getProduct(_w: CapitalWallet, id: string): Promise<CapitalProduct | null> {
    this.log('getProduct');
    this.down('get capital product');
    const p = this.products.find((x) => x.id === id);
    return Promise.resolve(
      p && this.currencies.includes(p.currency) ? p : null,
    );
  }

  reserve(
    w: CapitalWallet,
    input: {
      productId: string;
      type: CapitalProductType;
      amountMinor: number;
      lockInvestment: boolean;
    },
  ): Promise<CapitalReservation> {
    this.log('reserve');
    this.down('reserve capital order');
    const p = this.products.find((x) => x.id === input.productId)!;
    const share = p.type === 'SHARE_OFFERING';
    const shares = share
      ? Math.floor(input.amountMinor / p.share!.offerPriceMinor!)
      : null;
    const base = share
      ? shares! * p.share!.offerPriceMinor!
      : input.amountMinor;
    const crossDeal = share ? Math.floor(base * 0.01) : null;
    const quote: CapitalQuote = {
      type: p.type,
      currency: p.currency,
      totalDebitMinor: base + (crossDeal ?? 0),
      principalMinor: share ? null : input.amountMinor,
      tenorDays: p.tenorDays,
      lockedRate: p.annualRate,
      rateSource: share ? null : 'primary',
      dayCount: share ? null : 365,
      locked: share ? null : input.lockInvestment,
      allowEarlyWithdrawal: share ? null : p.allowEarlyWithdrawal,
      earliestWithdrawalDays: null,
      penaltyRate: share ? null : 0.15,
      deductibles: p.deductibles,
      requestedMinor: share ? input.amountMinor : null,
      requestedShares: shares,
      allocatedShares: shares,
      unallocatedMinor: share ? input.amountMinor - base : null,
      offerPriceMinor: share ? p.share!.offerPriceMinor : null,
      baseCostMinor: share ? base : null,
      brokerageFeeMinor: share ? 0 : null,
      crossDealFeeMinor: crossDeal,
      lockPeriodDays: share ? p.share!.lockPeriodDays : null,
    };
    const id = `01ORD${randomUUID().replace(/-/g, '').slice(0, 21).toUpperCase()}`;
    const now = Date.now();
    const order: CapitalOrder = {
      id,
      productId: p.id,
      type: p.type,
      currency: p.currency,
      amountMinor: quote.totalDebitMinor,
      reservedQuantity: shares,
      status: 'RESERVED',
      statusReason: null,
      expiresAt: new Date(now + this.reservationMs).toISOString(),
      confirmedAt: null,
      createdAt: new Date(now).toISOString(),
      account: null,
      agreements: p.documents,
    };
    const ids = w.walletId;
    this.orders.set(id, {
      order,
      quote,
      walletId: ids,
      accountId: ids,
      userCapitalAccountId: `01UCA${randomUUID().replace(/-/g, '').slice(0, 21).toUpperCase()}`,
    });
    return Promise.resolve({
      orderId: id,
      expiresAt: order.expiresAt!,
      currency: p.currency,
      quote,
    });
  }

  confirm(w: CapitalWallet, orderId: string): Promise<CapitalConfirmation> {
    this.log('confirm');
    this.down('confirm capital order');
    const held = this.orders.get(orderId);
    if (!held) return Promise.reject(this.refusal('reservation_expired'));
    const o = held.order;
    if (o.status !== 'RESERVED') {
      // Dev (24 Oct): a second confirm is 400 invalid for state.
      return Promise.reject(this.refusal('reservation_expired'));
    }
    if (new Date(o.expiresAt!).getTime() <= Date.now()) {
      o.status = 'EXPIRED';
      return Promise.reject(this.refusal('reservation_expired'));
    }
    const account = this.seam.accounts.get(w.walletId)!;
    if (
      this.shortNextConfirm ||
      account.availableKobo < BigInt(held.quote.totalDebitMinor)
    ) {
      this.shortNextConfirm = false;
      return Promise.reject(
        new WalletProviderError({
          kind: 'insufficient_funds',
          provider: 'nuvion',
          operation: 'confirm capital order',
        }),
      );
    }
    account.availableKobo -= BigInt(held.quote.totalDebitMinor);
    const now = Date.now();
    o.status = 'APPROVED';
    o.confirmedAt = new Date(now).toISOString();
    const share = held.quote.type === 'SHARE_OFFERING';
    const acct: CapitalAccount = {
      id: `01CAP${randomUUID().replace(/-/g, '').slice(0, 21).toUpperCase()}`,
      type: held.quote.type,
      currency: 'NGN',
      numberLast4: '4002',
      lifecycle: share ? 'LOCKED' : 'ACTIVE',
      payoutStatus: null,
      principalMinor: held.quote.principalMinor,
      lockedRate: held.quote.lockedRate,
      dayCount: held.quote.dayCount,
      tenorDays: held.quote.tenorDays,
      startedAt: o.confirmedAt,
      maturesAt: share ? null : new Date(now + 90 * 86_400_000).toISOString(),
      earlyActionAt: share || held.quote.locked === true ? null : o.confirmedAt,
      accruedMinor: share ? null : 0,
      dueInterestMinor: share
        ? null
        : Math.floor((held.quote.principalMinor ?? 0) * 0.066),
      grossInterestMinor: share
        ? null
        : Math.floor((held.quote.principalMinor ?? 0) * 0.074),
      totalDeductionsMinor: share
        ? null
        : Math.floor((held.quote.principalMinor ?? 0) * 0.008),
      expectedNetPayoutMinor: share
        ? null
        : (held.quote.principalMinor ?? 0) +
          Math.floor((held.quote.principalMinor ?? 0) * 0.066),
      netPayoutMinor: null,
      settlementAt: null,
      sharesPurchased: held.quote.allocatedShares,
      unitsHeld: held.quote.allocatedShares,
      baseCostMinor: held.quote.baseCostMinor,
      totalDebitedMinor: share ? held.quote.totalDebitMinor : null,
      lockExpiresAt: null,
      currentValueMinor: null,
      pendingRefundMinor: null,
    };
    o.account = acct;
    if (this.loseNextConfirm) {
      this.loseNextConfirm = false;
      return Promise.reject(
        new WalletProviderError({
          kind: 'outcome_unknown',
          provider: 'nuvion',
          operation: 'confirm capital order',
          recordMayExist: true,
        }),
      );
    }
    return Promise.resolve({
      orderId,
      status: 'APPROVED',
      capitalAccountId: acct.id,
      userCapitalAccountId: held.userCapitalAccountId,
    });
  }

  private refusal(refusal: 'reservation_expired' | 'withdrawal_not_available') {
    return new WalletProviderCapitalError({
      refusal,
      provider: 'nuvion',
      operation: 'capital',
      httpStatus: 400,
    });
  }

  getOrder(_w: CapitalWallet, orderId: string): Promise<CapitalOrder | null> {
    this.log('getOrder');
    this.down('get capital order');
    const h = this.orders.get(orderId);
    if (!h) return Promise.resolve(null);
    if (
      h.order.status === 'RESERVED' &&
      new Date(h.order.expiresAt!).getTime() <= Date.now()
    ) {
      h.order.status = 'EXPIRED';
    }
    return Promise.resolve(structuredClone(h.order));
  }

  listOrders(): Promise<CapitalPage<CapitalOrder>> {
    return Promise.resolve({
      items: [...this.orders.values()].map((h) => structuredClone(h.order)),
      nextCursor: null,
    });
  }

  portfolio(w: CapitalWallet): Promise<CapitalPortfolioLine[]> {
    this.log('portfolio');
    this.down('capital portfolio');
    let invested = 0;
    for (const h of this.orders.values()) {
      if (h.walletId !== w.walletId || h.order.status !== 'APPROVED') continue;
      if (h.order.account?.lifecycle === 'WITHDRAWN') continue;
      invested += h.quote.totalDebitMinor;
    }
    return Promise.resolve(
      invested === 0
        ? []
        : [
            {
              currency: 'NGN',
              investedMinor: invested,
              returnMinor: 0,
              valueMinor: invested,
            },
          ],
    );
  }

  transactions(
    _w: CapitalWallet,
    capitalAccountId: string,
  ): Promise<CapitalPage<CapitalTransaction>> {
    this.log('transactions');
    const h = [...this.orders.values()].find(
      (x) => x.order.account?.id === capitalAccountId,
    );
    const items: CapitalTransaction[] = h
      ? [
          {
            id: `01TXN${randomUUID().replace(/-/g, '').slice(0, 21).toUpperCase()}`,
            eventType: 'PURCHASE',
            amountMinor: h.quote.totalDebitMinor,
            accruedOn: null,
            createdAt: h.order.confirmedAt,
          },
        ]
      : [];
    return Promise.resolve({ items, nextCursor: null });
  }

  withdrawalPreview(
    _w: CapitalWallet,
    orderId: string,
  ): Promise<CapitalWithdrawalPreview> {
    this.log('withdrawalPreview');
    const h = this.orders.get(orderId);
    if (!h?.order.account)
      return Promise.reject(this.refusal('withdrawal_not_available'));
    return Promise.resolve({
      grossInterestMinor: 0,
      penaltyRate: 0.15,
      penaltyMinor: 0,
      deductionsMinor: 0,
      netPayoutMinor: h.quote.principalMinor ?? 0,
      daysElapsed: 0,
    });
  }

  withdraw(_w: CapitalWallet, orderId: string): Promise<CapitalOrder> {
    this.log('withdraw');
    this.down('withdraw capital order');
    const h = this.orders.get(orderId);
    const a = h?.order.account;
    if (
      !h ||
      !a ||
      a.lifecycle !== 'ACTIVE' ||
      h.quote.type !== 'FIXED_RETURN'
    ) {
      return Promise.reject(this.refusal('withdrawal_not_available'));
    }
    a.lifecycle = 'EARLY_LIQUIDATING';
    a.payoutStatus = 'pending';
    a.netPayoutMinor = h.quote.principalMinor;
    return Promise.resolve(structuredClone(h.order));
  }

  /** Nuvion settles payouts a few seconds later: the money returns to the funding account. */
  settlePayouts(): void {
    for (const h of this.orders.values()) {
      const a = h.order.account;
      if (a?.lifecycle !== 'EARLY_LIQUIDATING') continue;
      a.lifecycle = 'WITHDRAWN';
      a.payoutStatus = 'completed';
      const account = this.seam.accounts.get(h.walletId)!;
      account.availableKobo += BigInt(a.netPayoutMinor ?? 0);
    }
  }

  /** The order has been left to run out. */
  expire(orderId: string): void {
    const h = this.orders.get(orderId)!;
    h.order.expiresAt = new Date(Date.now() - 1000).toISOString();
  }

  /** Marks a holding as matured, as Nuvion does when the term ends. */
  mature(orderId: string): void {
    const a = this.orders.get(orderId)!.order.account!;
    a.lifecycle = 'MATURED';
  }
}
