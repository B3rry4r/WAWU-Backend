import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { OpenWallet } from '../../money/gate/wallet-gate';
import { MoneyError } from '../../money/money-error';
import type { PaymentStatus, PaymentView } from '../../money/money-view.type';
import {
  type CompletedPayment,
  PayableRegistry,
  type PayableLookup,
  type PayableTarget,
} from '../../money/payments/payable-registry';
import {
  PAYMENT_CURRENCY,
  WalletPaymentService,
} from '../../money/payments/wallet-payment.service';
import { PointsService } from '../../points/points.service';
import type { PlanTransferOrder } from '../../../generated/prisma/client';
import { BillingCurrencyService } from '../billing-currency.service';
import { MakerTierService } from '../maker-tier.service';
import { INT4_MAX, PLANS_CONFIG, type PlansConfig } from '../plans-config';
import type { PlanCurrency } from '../plans-view.type';
import type { PlanPurchaseQuoteQueryDto } from './plan-purchase.dto';
import { PurchaseRefusal } from './plan-purchase-rules';
import {
  packIdOf,
  packTargetIdOf,
  POINTS_PACK_KIND,
} from './plan-purchase-terms';
import type { PlanPurchaseTransferView } from './plan-purchase-view.type';
import {
  EXPIRED_MESSAGE,
  ORDER_STATUS,
  SETTLING_MESSAGE,
} from './plan-transfer-order';
import {
  packGoodsFromJson,
  packGoodsOf,
  packGoodsToTerms,
  packGoodsFromTerms,
} from './points-pack-goods';
import {
  PACK_NOT_FOUND_MESSAGE,
  packTitle,
  pricePack,
  type PackPlan,
} from './points-pack-rules';
import type {
  PointsPackPurchaseStatus,
  PointsPackPurchaseView,
  PointsPackQuoteView,
} from './points-pack-view.type';

/** A day, in milliseconds. */
const DAY_MS = 86_400_000;

/**
 * Buy a points pack from the wallet or by bank transfer (task POINTS-02, PT4
 * to PT4c, R-43, R-44).
 *
 * - **The payment is MONEY-17's.** A pack is a wallet payment of kind
 *   `points_pack` into WAWU's own account: WAWU's own sale, so there is no
 *   seller split and nothing is held (R-19 is for money owed to someone
 *   else). The provider's charge is on top, as on every purchase (R-10), and
 *   is shown as the Bank charge.
 * - **The terms are the payment's target and goods.** `pack-s` names the pack;
 *   the pack's points, the Founding Maker's bonus and the days the lot lasts
 *   are the payment's `terms` (`points-pack-goods.ts`): the quote token is
 *   bound to them (a pack, price, bonus or expiry that changed since the
 *   quote is `409 quote_changed`) and the payment keeps them from the claim,
 *   so what is granted is what was quoted.
 * - **Every figure is a setting.** The price, the points, the expiry and the
 *   bonus percent are read from the live plan (TIER-06, R-65) on each call;
 *   none is written here.
 * - **Granted once per payment.** `onCompleted` runs in the request, and
 *   again from the payment sweep until it has succeeded, on any server. It
 *   fixes the billing currency at a first purchase and grants one lot of
 *   points under the key (`pack`, the payment's id), last in its transaction:
 *   the same payment again finds its lot and writes nothing. Nothing is held
 *   across a provider call: delivery is the database only.
 * - **By transfer** it is the tier purchase's own order (TIER-05,
 *   `PlanTransferService`): the order waits for the money to land in the
 *   person's wallet, then pays from the wallet once.
 */
@Injectable()
export class PointsPackService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PLANS_CONFIG) private readonly config: PlansConfig,
    private readonly tiers: MakerTierService,
    private readonly billing: BillingCurrencyService,
    private readonly points: PointsService,
    private readonly payments: WalletPaymentService,
    private readonly registry: PayableRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      kind: POINTS_PACK_KIND,
      resolve: (lookup) => this.resolve(lookup),
      onCompleted: (payment) => this.deliver(payment),
    });
  }

  // -------------------------------------------------------------------------
  // The routes' side
  // -------------------------------------------------------------------------

  /** The payment target of a request for this pack. */
  targetOf(packId: string | undefined): string {
    const id = packId === undefined ? null : packTargetIdOf(packId);
    if (id === null)
      throw new MoneyError('target_not_found', PACK_NOT_FOUND_MESSAGE);
    return id;
  }

  /** The pay sheet (PT4): the pack priced for the person, with the wallet payment's quote. */
  async quote(
    wallet: OpenWallet,
    q: Pick<PlanPurchaseQuoteQueryDto, 'packId'>,
  ): Promise<PointsPackQuoteView> {
    const targetId = this.targetOf(q.packId);
    const plan = await this.priced(wallet.wawuUserId, q.packId ?? '');
    const payment = await this.payments.quote(wallet, {
      kind: POINTS_PACK_KIND,
      targetId,
    });
    return {
      kind: POINTS_PACK_KIND,
      packId: plan.pack.id,
      currency: plan.currency,
      packMinor: plan.priceMinor,
      points: plan.points,
      bonusPercent: plan.bonusPercent,
      bonusPoints: plan.bonusPoints,
      totalPoints: plan.totalPoints,
      expiryDays: plan.boughtExpiryDays,
      paymentKind: POINTS_PACK_KIND,
      payment,
    };
  }

  // -------------------------------------------------------------------------
  // The payment's side: what is priced, and what is delivered
  // -------------------------------------------------------------------------

  /** Prices the pack in the target for the payer, or refuses it. Moves nothing. */
  private async resolve(lookup: PayableLookup): Promise<PayableTarget> {
    const packId = packIdOf(POINTS_PACK_KIND, lookup.targetId);
    if (packId === null)
      throw new MoneyError('target_not_found', PACK_NOT_FOUND_MESSAGE);
    const plan = await this.priced(lookup.payerWawuUserId, packId);
    return {
      title: packTitle(plan),
      priceKobo: plan.priceMinor,
      payee: null,
      currency: plan.currency,
      terms: packGoodsToTerms(packGoodsOf(plan)),
    };
  }

  private async priced(wawuUserId: string, packId: string): Promise<PackPlan> {
    const [held, billing] = await Promise.all([
      this.tiers.tierOf(wawuUserId),
      this.billing.resolve(wawuUserId, {}),
    ]);
    try {
      return pricePack(this.config, billing.currency, held, packId);
    } catch (e) {
      if (e instanceof PurchaseRefusal) throw new MoneyError(e.code, e.message);
      throw e;
    }
  }

  /**
   * The payment is confirmed: add the points it bought, once. Idempotent and
   * safe to run on two servers at once. The lot is the points service's own
   * (`pack`, the payment's id), so a repeat grants nothing; the grant is the
   * last write of the transaction and the only thing it waits on is the
   * database. Anything that goes wrong throws, and the payment service tries
   * again and then sends it to review with the money safe in WAWU's account.
   */
  private async deliver(payment: CompletedPayment): Promise<void> {
    if (packIdOf(payment.kind, payment.targetId) === null)
      throw new Error(`Payment ${payment.paymentId} names no points pack.`);
    if (
      !Number.isSafeInteger(payment.priceKobo) ||
      payment.priceKobo < 1 ||
      payment.priceKobo > INT4_MAX
    )
      throw new Error(`Payment ${payment.paymentId} has no usable price.`);
    const goods = packGoodsFromTerms(payment.terms);
    const total = goods.points + goods.bonusPoints;
    if (total > INT4_MAX)
      throw new Error(`Payment ${payment.paymentId} has too many points.`);
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
          source: 'pack',
          sourceRef: payment.paymentId,
          points: total,
          expiresAt: new Date(now.getTime() + goods.boughtExpiryDays * DAY_MS),
        },
        { tx, now },
      );
    });
  }

  // -------------------------------------------------------------------------
  // What the routes answer
  // -------------------------------------------------------------------------

  /** The pack purchase a payment is, as the routes answer it and the key stores it. */
  async present(
    view: PaymentView,
    order: PlanTransferOrder | null,
  ): Promise<PointsPackPurchaseView> {
    const packId = packIdOf(view.kind, view.targetId);
    if (packId === null)
      throw new Error(`Payment ${view.id} is not a points pack payment.`);
    const [row, lot] = await Promise.all([
      this.prisma.walletPayment.findUniqueOrThrow({
        where: { id: view.id },
        select: { terms: true },
      }),
      this.prisma.pointLot.findUnique({
        where: {
          source_sourceRef: { source: 'pack', sourceRef: view.id },
        },
      }),
    ]);
    const goods = packGoodsFromJson(row.terms);
    return {
      id: order?.id ?? view.id,
      kind: POINTS_PACK_KIND,
      packId,
      method: order ? 'transfer' : 'wallet',
      currency: PAYMENT_CURRENCY as PlanCurrency,
      amountMinor: view.priceKobo,
      points: goods.points,
      bonusPoints: goods.bonusPoints,
      status: lot ? 'paid' : statusOf(view.status),
      statusMessage: lot ? null : (view.failureReason ?? view.statusMessage),
      payment: view,
      transfer: null,
      grant: lot
        ? {
            points: goods.points,
            bonusPoints: goods.bonusPoints,
            totalPoints: lot.quantity,
            expiresAt: lot.expiresAt.toISOString(),
          }
        : null,
      createdAt: view.createdAt,
      paidAt: lot ? lot.createdAt.toISOString() : null,
    };
  }

  /**
   * A pack bought by transfer that has no wallet payment yet, or never got
   * one. `waiting` is true while the money has not landed and the time has not
   * run out, and `transfer` is where to send it.
   */
  presentOrder(
    order: PlanTransferOrder,
    waiting: boolean,
    transfer: PlanPurchaseTransferView | null,
  ): PointsPackPurchaseView {
    const packId = packIdOf(order.paymentKind, order.targetId);
    if (packId === null)
      throw new Error(`Order ${order.id} is not a points pack purchase.`);
    const goods = packGoodsFromJson(order.terms);
    const base = {
      id: order.id,
      kind: POINTS_PACK_KIND,
      packId,
      method: 'transfer' as const,
      currency: PAYMENT_CURRENCY as PlanCurrency,
      amountMinor: order.priceKobo,
      points: goods.points,
      bonusPoints: goods.bonusPoints,
      payment: null,
      transfer: null,
      grant: null,
      createdAt: order.createdAt.toISOString(),
      paidAt: null,
    };
    const answer = (
      status: PointsPackPurchaseStatus,
      statusMessage: string | null,
    ): PointsPackPurchaseView => ({ ...base, status, statusMessage });
    if (waiting)
      return {
        ...answer('awaiting_transfer', order.statusMessage),
        transfer,
      };
    if (order.status === ORDER_STATUS.closed)
      return answer('failed', order.statusMessage);
    if (order.status === ORDER_STATUS.settling || order.status === 'settled')
      return answer('pending', SETTLING_MESSAGE);
    return answer('expired', order.statusMessage ?? EXPIRED_MESSAGE);
  }
}

/** A payment that is not paid, as a purchase status. */
function statusOf(status: PaymentStatus): PointsPackPurchaseStatus {
  switch (status) {
    case 'failed':
      return 'failed';
    case 'reversed':
      return 'reversed';
    default:
      return 'pending';
  }
}
