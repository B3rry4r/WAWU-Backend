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
import type { PlanTransferOrder } from '../../../generated/prisma/client';
import { BillingCurrencyService } from '../billing-currency.service';
import { MakerTierService } from '../maker-tier.service';
import { INT4_MAX, PLANS_CONFIG, type PlansConfig } from '../plans-config';
import type { PlanCurrency } from '../plans-view.type';
import { lockPersonTier } from '../tier-grant.service';
import {
  extraGoodsFromJson,
  extraGoodsFromTerms,
  extraGoodsOf,
  extraGoodsToTerms,
} from './extra-products-goods';
import {
  EXTRA_PRODUCTS_TITLE,
  priceExtraProducts,
  type ExtraProductsPlan,
} from './extra-products-rules';
import type {
  ExtraProductsPurchaseStatus,
  ExtraProductsPurchaseView,
  ExtraProductsQuoteView,
} from './extra-products-view.type';
import { PurchaseRefusal } from './plan-purchase-rules';
import {
  EXTRA_PRODUCTS_KIND,
  EXTRA_PRODUCTS_TARGET_ID,
  isExtraProducts,
} from './plan-purchase-terms';
import type { PlanPurchaseTransferView } from './plan-purchase-view.type';
import {
  EXPIRED_MESSAGE,
  ORDER_STATUS,
  SETTLING_MESSAGE,
} from './plan-transfer-order';

/**
 * Add more products to a tier, from the wallet or by bank transfer (task
 * TIER-04, VF13, R-43, R-44, R-65).
 *
 * - **The payment is MONEY-17's.** The add-on is a wallet payment of kind
 *   `extra_products` into WAWU's own account: WAWU's own sale, so there is no
 *   seller split and nothing is held (R-19 is for money owed to someone
 *   else). The provider's charge is on top, as on every purchase (R-10), and
 *   is shown as the Bank charge.
 * - **Needs a running tier.** Without one the answer is `402 tier_required`
 *   before anything moves: when the quote is asked, when the payment is
 *   claimed, and when a bank-transfer purchase is about to be settled (that
 *   order is then closed with nothing taken).
 * - **Every figure is a setting.** The price and the number of products are
 *   read from the live plan (TIER-06, R-65) on each call; none is written
 *   here. The count is the payment's `terms`: the quote token is bound to it
 *   (a count changed since the quote is `409 quote_changed`) and the payment
 *   keeps it from the claim, so what is added is what was quoted, even when a
 *   setting changes while the payment confirms or a transfer waits.
 * - **Added once per payment.** `onCompleted` runs in the request, and again
 *   from the payment sweep until it has succeeded, on any server. Under the
 *   person's tier lock it writes the purchase row (`MakerExtraProducts`, primary
 *   key: the payment's id, the once-only gate) and then adds the count to the tier row's
 *   `extraProducts`, last, in a database-only transaction: the same payment
 *   again finds its row and adds nothing. Nothing is held across a provider
 *   call.
 * - **What is bought stays.** `extraProducts` lives on the tier row, which a
 *   renewal, a new tier bought after the last ended and an upgrade leave
 *   alone. The publishing gate counts it whenever the person holds a tier
 *   (TIER-02). A payment that confirms after the tier ended is still added: it
 *   waits for the next tier, so the person is never charged for nothing.
 * - **By transfer** it is the tier purchase's own order (TIER-05,
 *   `PlanTransferService`): the order waits for the money to land in the
 *   person's wallet, then pays from the wallet once.
 */
@Injectable()
export class ExtraProductsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PLANS_CONFIG) private readonly config: PlansConfig,
    private readonly tiers: MakerTierService,
    private readonly billing: BillingCurrencyService,
    private readonly payments: WalletPaymentService,
    private readonly registry: PayableRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      kind: EXTRA_PRODUCTS_KIND,
      resolve: (lookup) => this.resolve(lookup),
      onCompleted: (payment) => this.deliver(payment),
    });
  }

  // -------------------------------------------------------------------------
  // The routes' side
  // -------------------------------------------------------------------------

  /** The payment target of a request for the add-on. */
  targetOf(): string {
    return EXTRA_PRODUCTS_TARGET_ID;
  }

  /** The pay sheet (VF13): the add-on priced for the person, with the wallet payment's quote. */
  async quote(wallet: OpenWallet): Promise<ExtraProductsQuoteView> {
    const plan = await this.priced(wallet.wawuUserId);
    const payment = await this.payments.quote(wallet, {
      kind: EXTRA_PRODUCTS_KIND,
      targetId: EXTRA_PRODUCTS_TARGET_ID,
    });
    return {
      kind: EXTRA_PRODUCTS_KIND,
      currency: plan.currency,
      extraMinor: plan.priceMinor,
      products: plan.products,
      productsAllowed: plan.productsAllowed,
      productsAllowedAfter: plan.productsAllowedAfter,
      paymentKind: EXTRA_PRODUCTS_KIND,
      payment,
    };
  }

  // -------------------------------------------------------------------------
  // The payment's side: what is priced, and what is delivered
  // -------------------------------------------------------------------------

  /** Prices the add-on for the payer, or refuses it. Moves nothing. */
  private async resolve(lookup: PayableLookup): Promise<PayableTarget> {
    if (lookup.targetId !== EXTRA_PRODUCTS_TARGET_ID)
      throw new MoneyError(
        'target_not_found',
        'We could not find that add-on.',
      );
    const plan = await this.priced(lookup.payerWawuUserId);
    return {
      title: EXTRA_PRODUCTS_TITLE,
      priceKobo: plan.priceMinor,
      payee: null,
      currency: plan.currency,
      terms: extraGoodsToTerms(extraGoodsOf(plan)),
    };
  }

  private async priced(wawuUserId: string): Promise<ExtraProductsPlan> {
    const [held, billing] = await Promise.all([
      this.tiers.tierOf(wawuUserId),
      this.billing.resolve(wawuUserId, {}),
    ]);
    try {
      return priceExtraProducts(this.config, billing.currency, held);
    } catch (e) {
      if (e instanceof PurchaseRefusal) throw new MoneyError(e.code, e.message);
      throw e;
    }
  }

  /**
   * The payment is confirmed: add the products it bought, once. Idempotent and
   * safe to run on two servers at once. The purchase row is the gate (its key
   * is the payment's id), and the increment is the last write of a
   * transaction that waits on nothing but the database. Anything that goes
   * wrong throws, and the payment service tries again and then sends it to
   * review with the money safe in WAWU's account.
   */
  private async deliver(payment: CompletedPayment): Promise<void> {
    if (!isExtraProducts(payment.kind, payment.targetId))
      throw new Error(`Payment ${payment.paymentId} names no extra products.`);
    if (
      !Number.isSafeInteger(payment.priceKobo) ||
      payment.priceKobo < 1 ||
      payment.priceKobo > INT4_MAX
    )
      throw new Error(`Payment ${payment.paymentId} has no usable price.`);
    const goods = extraGoodsFromTerms(payment.terms);
    const wawuUserId = payment.payerWawuUserId;
    await this.prisma.$transaction(async (tx) => {
      await lockPersonTier(tx, wawuUserId);
      const held = await tx.makerTier.findUnique({
        where: { wawuUserId },
        select: { tierId: true, extraProducts: true },
      });
      if (held === null)
        throw new Error(
          `Payment ${payment.paymentId}: the person holds no tier to add products to.`,
        );
      if (held.extraProducts + goods.products > INT4_MAX)
        throw new Error(
          `Payment ${payment.paymentId}: too many extra products for one account.`,
        );
      // The once-per-payment gate: the row's key is the payment's id.
      const { count } = await tx.makerExtraProducts.createMany({
        data: [
          {
            paymentRef: payment.paymentId,
            wawuUserId,
            tierId: held.tierId,
            products: goods.products,
            currency: PAYMENT_CURRENCY,
            amountMinor: payment.priceKobo,
          },
        ],
        skipDuplicates: true,
      });
      if (count === 0) return;
      const fixed = await this.billing.fixAtFirstPurchase(
        { wawuUserId, purchaseRef: payment.paymentId },
        tx,
      );
      if (fixed !== PAYMENT_CURRENCY)
        throw new Error(
          `Payment ${payment.paymentId}: the person is billed in another currency than the one that was paid.`,
        );
      await tx.makerTier.update({
        where: { wawuUserId },
        data: { extraProducts: { increment: goods.products } },
      });
    });
  }

  // -------------------------------------------------------------------------
  // What the routes answer
  // -------------------------------------------------------------------------

  /** The purchase a payment is, as the routes answer it and the key stores it. */
  async present(
    view: PaymentView,
    order: PlanTransferOrder | null,
  ): Promise<ExtraProductsPurchaseView> {
    if (!isExtraProducts(view.kind, view.targetId))
      throw new Error(`Payment ${view.id} is not an extra products payment.`);
    const [row, stored] = await Promise.all([
      this.prisma.makerExtraProducts.findUnique({
        where: { paymentRef: view.id },
      }),
      this.prisma.walletPayment.findUniqueOrThrow({
        where: { id: view.id },
        select: { terms: true },
      }),
    ]);
    const goods = extraGoodsFromJson(stored.terms);
    const held = row ? await this.tiers.tierOf(row.wawuUserId) : null;
    return {
      id: order?.id ?? view.id,
      kind: EXTRA_PRODUCTS_KIND,
      method: order ? 'transfer' : 'wallet',
      currency: PAYMENT_CURRENCY as PlanCurrency,
      amountMinor: view.priceKobo,
      products: goods.products,
      status: row ? 'paid' : statusOf(view.status),
      statusMessage: row ? null : (view.failureReason ?? view.statusMessage),
      payment: view,
      transfer: null,
      grant:
        row && held
          ? {
              productsAdded: goods.products,
              extraProducts: held.extraProducts,
              productsAllowed: held.productsAllowed,
            }
          : null,
      createdAt: view.createdAt,
      paidAt: row ? row.createdAt.toISOString() : null,
    };
  }

  /**
   * An add-on bought by transfer that has no wallet payment yet, or never got
   * one. `waiting` is true while the money has not landed and the time has not
   * run out, and `transfer` is where to send it.
   */
  presentOrder(
    order: PlanTransferOrder,
    waiting: boolean,
    transfer: PlanPurchaseTransferView | null,
  ): ExtraProductsPurchaseView {
    if (!isExtraProducts(order.paymentKind, order.targetId))
      throw new Error(`Order ${order.id} is not an extra products purchase.`);
    const goods = extraGoodsFromJson(order.terms);
    const base = {
      id: order.id,
      kind: EXTRA_PRODUCTS_KIND,
      method: 'transfer' as const,
      currency: PAYMENT_CURRENCY as PlanCurrency,
      amountMinor: order.priceKobo,
      products: goods.products,
      payment: null,
      transfer: null,
      grant: null,
      createdAt: order.createdAt.toISOString(),
      paidAt: null,
    };
    const answer = (
      status: ExtraProductsPurchaseStatus,
      statusMessage: string | null,
    ): ExtraProductsPurchaseView => ({ ...base, status, statusMessage });
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
function statusOf(status: PaymentStatus): ExtraProductsPurchaseStatus {
  switch (status) {
    case 'failed':
      return 'failed';
    case 'reversed':
      return 'reversed';
    default:
      return 'pending';
  }
}
