import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WalletGate, type OpenWallet } from '../../money/gate/wallet-gate';
import { MoneyError } from '../../money/money-error';
import type { PaymentStatus, PaymentView } from '../../money/money-view.type';
import type { IdempotencyScope } from '../../money/payments/idempotency';
import {
  type CompletedPayment,
  type PayableLookup,
  type PayableTarget,
  PayableRegistry,
} from '../../money/payments/payable-registry';
import {
  PAYMENT_CURRENCY,
  WalletPaymentService,
} from '../../money/payments/wallet-payment.service';
import { BillingCurrencyService } from '../../plans/billing-currency.service';
import {
  PLANS_CONFIG,
  priceIn,
  type PlansConfig,
} from '../../plans/plans-config';
import { PointsError } from '../points-error';
import { PointsService } from '../points.service';
import type { PointsShortfallDto } from './points-spend.dto';
import {
  shortfallGoodsFromJson,
  shortfallGoodsFromTerms,
  shortfallGoodsToTerms,
  shortfallPointsOf,
  shortfallTargetOf,
} from './points-shortfall-goods';
import { capError, shortfallPriceMinor } from './points-spend-rules';
import { PointsSpendService } from './points-spend.service';
import type {
  PointsShortfallOfferView,
  PointsShortfallStatus,
  PointsShortfallView,
} from './points-spend-view.type';

/** The wallet payment kind of a shortfall (POINTS-03). */
export const POINTS_SHORTFALL_KIND = 'points_shortfall' as const;

/** The route a shortfall purchase's Idempotency-Key is scoped to. */
export const SHORTFALL_ROUTE = 'POST points/shortfall';

export const SHORTFALL_NOT_FOUND_MESSAGE =
  'We could not find those points to buy.';
export const SHORTFALL_NOT_FOUND_PURCHASE_MESSAGE =
  'We could not find that purchase.';
export const NOT_SHORT_MESSAGE = 'You already have enough points for this.';
export const NO_WALLET_NOTE = 'Open your wallet to top up points from it.';
export const DOLLARS_NOTE =
  'Topping up points from your wallet is in naira only for now.';

/** A day, in milliseconds. */
const DAY_MS = 86_400_000;

/**
 * Pay the points an AI job is short of from the wallet (task POINTS-03, PT3,
 * R-43, R-10, R-16, R-19).
 *
 * - **Nothing without a confirm.** The quote (`offer`) shows the wallet money
 *   and takes nothing. The points are bought only by `POST /points/shortfall`
 *   with the PIN: "Without confirm, do nothing". "Use wallet" decides only
 *   whether the quote offers it; the PIN is the person's consent.
 * - **The payment is MONEY-17's.** A shortfall is a wallet payment of kind
 *   `points_shortfall` into WAWU's own account: WAWU's own sale, no seller
 *   split, nothing held. The provider's charge is on top (R-10) and is shown
 *   as the Bank charge. Naira only (R-16): a person billed in dollars is
 *   priced in dollars and refused `target_not_payable` by the payment
 *   service, nothing taken.
 * - **Priced at the pack rate**, `points.price_kobo_per_1000` (R-65): the
 *   shortfall's points pro rata, rounded up to a whole kobo.
 * - **The quote binds points, rate and expiry.** They are the payment's
 *   terms: a shortfall that changed since the quote (the balance moved, the
 *   rate or the expiry setting changed) is `409 quote_changed` with the new
 *   quote, before anything moves. The target carries the
 *   points, so a quote token cannot buy a different amount, and once the
 *   points are bought there is no shortfall left: the same token under
 *   another Idempotency-Key is `points_not_short`, never a second purchase
 *   (TIER-06 round 2, low L1: a fresh quote for each attempt).
 * - **Granted once per payment.** `onCompleted` runs in the request, and
 *   again from the payment sweep until it succeeds, on any server: it fixes
 *   the billing currency at a first purchase and grants one lot (source
 *   `shortfall`, keyed by the payment), last, in a database-only transaction.
 *   Nothing is held across a provider call.
 */
@Injectable()
export class PointsShortfallService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PLANS_CONFIG) private readonly config: PlansConfig,
    private readonly billing: BillingCurrencyService,
    private readonly points: PointsService,
    private readonly spend: PointsSpendService,
    private readonly payments: WalletPaymentService,
    private readonly registry: PayableRegistry,
    private readonly gate: WalletGate,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      kind: POINTS_SHORTFALL_KIND,
      resolve: (lookup) => this.resolve(lookup),
      onCompleted: (payment) => this.deliver(payment),
    });
    this.payments.presentRoute(SHORTFALL_ROUTE, (view) => this.present(view));
  }

  // -------------------------------------------------------------------------
  // The quote's side
  // -------------------------------------------------------------------------

  /**
   * The wallet money for `shortfallPoints`, with the wallet payment's own
   * signed quote, or null with the reason in words. Takes nothing.
   */
  async offer(
    wawuUserId: string,
    shortfallPoints: number,
  ): Promise<{ wallet: PointsShortfallOfferView | null; note: string | null }> {
    // The note, in order: a billing currency fixed in dollars (the dollars
    // note); else no open wallet (open one: the normal case under R-6, and
    // the unfixed currency without claims reads USD, so it must not decide
    // before this); else the currency as priced.
    const billing = await this.billing.resolve(wawuUserId, {});
    if (billing.fixed && billing.currency !== 'NGN')
      return { wallet: null, note: DOLLARS_NOTE };
    const wallet = await this.walletOf(wawuUserId);
    if (wallet === null) return { wallet: null, note: NO_WALLET_NOTE };
    if (billing.currency !== 'NGN') return { wallet: null, note: DOLLARS_NOTE };
    const targetId = shortfallTargetOf(shortfallPoints);
    try {
      const payment = await this.payments.quote(wallet, {
        kind: POINTS_SHORTFALL_KIND,
        targetId,
      });
      return {
        wallet: {
          currency: PAYMENT_CURRENCY,
          points: shortfallPoints,
          priceKobo: payment.priceKobo,
          per1000PointsKobo: priceIn(
            this.config.points.pricePer1000Points,
            'NGN',
          ),
          payment,
        },
        note: null,
      };
    } catch (e) {
      // The money side cannot price it right now (fees not set, too large a
      // payment): the job's cost and shortfall are still told.
      if (e instanceof MoneyError) return { wallet: null, note: e.message };
      throw e;
    }
  }

  private async walletOf(wawuUserId: string): Promise<OpenWallet | null> {
    try {
      return await this.gate.requireOpen(wawuUserId);
    } catch (e) {
      if (e instanceof MoneyError) return null;
      throw e;
    }
  }

  // -------------------------------------------------------------------------
  // The route's side
  // -------------------------------------------------------------------------

  /**
   * Buys exactly the shortfall of this job from the wallet, once. Before
   * anything moves: a cap that stops the job is
   * `422 points_cap_reached`, a person who is not short is `409
   * points_not_short`, a quote that changed is `409 quote_changed`.
   */
  async buy(
    wallet: OpenWallet,
    scope: IdempotencyScope,
    dto: PointsShortfallDto,
  ): Promise<PointsShortfallView> {
    const a = await this.spend.assess(wallet.wawuUserId, dto);
    if (a.cap) throw capError(a.cap);
    if (a.shortfallPoints <= 0)
      throw new PointsError('points_not_short', NOT_SHORT_MESSAGE, {
        balancePoints: a.balancePoints,
        neededPoints: a.job.costPoints,
        shortfallPoints: 0,
      });
    const payment = await this.payments.pay(
      wallet,
      {
        kind: POINTS_SHORTFALL_KIND,
        targetId: shortfallTargetOf(a.shortfallPoints),
        expectedTotalKobo: dto.expectedTotalKobo,
        quoteToken: dto.quoteToken,
      },
      scope,
    );
    return (
      (scope.answered as PointsShortfallView | undefined) ??
      this.present(payment)
    );
  }

  /** One purchase as it stands now: what the app polls after `pending`. Only the buyer reads it. */
  async read(wawuUserId: string, id: string): Promise<PointsShortfallView> {
    const payment = await this.prisma.walletPayment.findFirst({
      where: { id, payerWawuUserId: wawuUserId, kind: POINTS_SHORTFALL_KIND },
    });
    if (!payment)
      throw new MoneyError('not_found', SHORTFALL_NOT_FOUND_PURCHASE_MESSAGE);
    return this.present(this.payments.view(payment, null));
  }

  // -------------------------------------------------------------------------
  // The payment's side: what is priced, and what is delivered
  // -------------------------------------------------------------------------

  /** Prices the points in the target for the payer. Moves nothing. */
  private async resolve(lookup: PayableLookup): Promise<PayableTarget> {
    const points = shortfallPointsOf(lookup.targetId);
    if (points === null)
      throw new MoneyError('target_not_found', SHORTFALL_NOT_FOUND_MESSAGE);
    const billing = await this.billing.resolve(lookup.payerWawuUserId, {});
    const plan = this.config.points;
    const priceMinor = shortfallPriceMinor(
      plan.pricePer1000Points,
      billing.currency,
      points,
    );
    if (priceMinor === null)
      throw new MoneyError(
        'amount_out_of_range',
        'That many points cannot be bought at once.',
      );
    return {
      title: 'Points for an AI tool',
      priceKobo: priceMinor,
      payee: null,
      currency: billing.currency,
      terms: shortfallGoodsToTerms({
        points,
        per1000Minor: priceIn(plan.pricePer1000Points, billing.currency),
        expiryDays: plan.boughtExpiryDays,
      }),
    };
  }

  /**
   * The payment is confirmed: add the points it bought, once. Idempotent and
   * safe on two servers at once; the grant is the last write of the
   * transaction and the only thing it waits on is the database.
   */
  private async deliver(payment: CompletedPayment): Promise<void> {
    if (shortfallPointsOf(payment.targetId) === null)
      throw new Error(`Payment ${payment.paymentId} names no points.`);
    const goods = shortfallGoodsFromTerms(payment.terms);
    const wawuUserId = payment.payerWawuUserId;
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const fixed = await this.billing.fixAtFirstPurchase(
        { wawuUserId, purchaseRef: payment.paymentId },
        tx,
      );
      if (fixed !== PAYMENT_CURRENCY)
        throw new Error(
          `Payment ${payment.paymentId}: the person is billed in another currency than the one that was paid.`,
        );
      await this.points.grant(
        {
          wawuUserId,
          source: 'shortfall',
          sourceRef: payment.paymentId,
          points: goods.points,
          expiresAt: new Date(now.getTime() + goods.expiryDays * DAY_MS),
        },
        { tx, now },
      );
    });
  }

  // -------------------------------------------------------------------------
  // What the routes answer
  // -------------------------------------------------------------------------

  /** The purchase a payment is, as the routes answer it and the key stores it. */
  async present(view: PaymentView): Promise<PointsShortfallView> {
    if (shortfallPointsOf(view.targetId) === null)
      throw new Error(`Payment ${view.id} is not a points shortfall payment.`);
    const [row, lot] = await Promise.all([
      this.prisma.walletPayment.findUniqueOrThrow({
        where: { id: view.id },
        select: { terms: true },
      }),
      this.prisma.pointLot.findUnique({
        where: {
          source_sourceRef: { source: 'shortfall', sourceRef: view.id },
        },
      }),
    ]);
    const goods = shortfallGoodsFromJson(row.terms);
    return {
      id: view.id,
      currency: PAYMENT_CURRENCY,
      status: lot ? 'paid' : statusOf(view.status),
      statusMessage: lot ? null : (view.failureReason ?? view.statusMessage),
      points: goods.points,
      amountKobo: view.priceKobo,
      payment: view,
      grant: lot
        ? { points: lot.quantity, expiresAt: lot.expiresAt.toISOString() }
        : null,
      createdAt: view.createdAt,
      paidAt: lot ? lot.createdAt.toISOString() : null,
    };
  }
}

/** A payment that is not paid, as a purchase status. */
function statusOf(status: PaymentStatus): PointsShortfallStatus {
  switch (status) {
    case 'failed':
      return 'failed';
    case 'reversed':
      return 'reversed';
    default:
      return 'pending';
  }
}
