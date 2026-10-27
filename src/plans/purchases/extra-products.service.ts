import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WalletHoldService } from '../../money/holds/wallet-hold.service';
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
import {
  EXTRA_PRODUCTS_REFUND_CONDITION,
  packRefundedMessage,
  packRefundingMessage,
  PACK_NOT_ALLOWED_CODE,
  packRefusalFor,
  packRefusalMessage,
  packRuleOf,
} from './extra-products-cap';
import { isRunning, PurchaseRefusal } from './plan-purchase-rules';
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
    private readonly holds: WalletHoldService,
  ) {}

  private readonly logger = new Logger(ExtraProductsService.name);

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

  /**
   * PACK-CAP (R-100, round 3 M2): eligibility comes before any wallet or
   * payment gate. A person on a running tier that may not buy the pack, or who
   * holds the most packs, is refused `pack_not_allowed` here, so a Verify
   * person with no wallet is told the pack is not for them and not led to open
   * one for it. Without a running tier it is silent: `tier_required` is
   * answered later, as before.
   */
  async assertEligible(wawuUserId: string): Promise<void> {
    const held = await this.tiers.tierOf(wawuUserId);
    if (!isRunning(held)) return;
    const why = packRefusalFor(
      packRuleOf(this.config),
      held.tierId,
      held.extraProducts,
    );
    if (why !== null)
      throw new MoneyError(PACK_NOT_ALLOWED_CODE, packRefusalMessage(why));
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
    const outcome = await this.prisma.$transaction(
      async (tx): Promise<'added' | 'refund'> => {
        await lockPersonTier(tx, wawuUserId);
        // Already added by an earlier delivery of this payment: nothing more,
        // and never judged against the cap its own pack is part of.
        const done = await tx.makerExtraProducts.findUnique({
          where: { paymentRef: payment.paymentId },
          select: { paymentRef: true },
        });
        if (done) return 'added';
        // A payment already being paid back is never added, whatever has
        // changed since: the refund and the add are decided under this lock
        // and exclude each other.
        const paidBack = await tx.walletHold.findUnique({
          where: { paymentId: payment.paymentId },
          select: { id: true },
        });
        if (paidBack) return 'refund';
        const held = await tx.makerTier.findUnique({
          where: { wawuUserId },
          select: { tierId: true, extraProducts: true },
        });
        if (held === null)
          throw new Error(
            `Payment ${payment.paymentId}: the person holds no tier to add products to.`,
          );
        // PACK-CAP (R-100): the cap is judged again where the pack is added,
        // under the person's tier lock. Another channel (a store purchase)
        // can have taken the last place while this payment confirmed; the pack
        // is then not added and the whole price goes back, once.
        if (
          packRefusalFor(
            packRuleOf(this.config),
            held.tierId,
            held.extraProducts,
          ) !== null
        ) {
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
                releaseCondition: EXTRA_PRODUCTS_REFUND_CONDITION,
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
          return 'refund';
        }
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
        if (count === 0) return 'added';
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
        return 'added';
      },
    );
    if (outcome === 'refund') {
      this.logger.warn(
        `payment ${payment.paymentId}: the pack could not be added (the cap is reached); the price is being refunded`,
      );
      await this.holds.refund(
        { paymentId: payment.paymentId },
        'extra products not added: the most packs a profile can hold',
      );
    }
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
    // A pack that could not be added after the payment confirmed has a hold:
    // its price is going back, or has gone back.
    const payback = row
      ? null
      : await this.prisma.walletHold.findUnique({
          where: { paymentId: view.id },
          select: { status: true, amountKobo: true },
        });
    return {
      id: order?.id ?? view.id,
      kind: EXTRA_PRODUCTS_KIND,
      method: order ? 'transfer' : 'wallet',
      currency: PAYMENT_CURRENCY as PlanCurrency,
      amountMinor: view.priceKobo,
      products: goods.products,
      status: row ? 'paid' : payback ? 'refunded' : statusOf(view.status),
      statusMessage: row
        ? null
        : payback
          ? payback.status === 'refunded'
            ? packRefundedMessage(Number(payback.amountKobo))
            : packRefundingMessage(Number(payback.amountKobo))
          : (view.failureReason ?? view.statusMessage),
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
