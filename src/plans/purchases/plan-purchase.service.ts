import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { OpenWallet } from '../../money/gate/wallet-gate';
import { nairaText } from '../../money/insufficient-funds';
import { MoneyError } from '../../money/money-error';
import type { PaymentStatus, PaymentView } from '../../money/money-view.type';
import { WalletHoldService } from '../../money/holds/wallet-hold.service';
import { WalletOpeningService } from '../../money/opening/wallet-opening.service';
import type { IdempotencyScope } from '../../money/payments/idempotency';
import {
  type CompletedPayment,
  type PayableKindHandler,
  PayableRegistry,
  type PayableLookup,
  type PayableTarget,
} from '../../money/payments/payable-registry';
import {
  FINISHING_MESSAGE,
  PAYMENT_CURRENCY,
  STILL_CONFIRMING_MESSAGE,
  WalletPaymentService,
} from '../../money/payments/wallet-payment.service';
import { PointsService } from '../../points/points.service';
import type { PlanTransferOrder } from '../../../generated/prisma/client';
import { BillingCurrencyService } from '../billing-currency.service';
import type { PlanCurrency } from '../plans-view.type';
import { MakerTierService } from '../maker-tier.service';
import {
  countIn,
  INT4_MAX,
  PLANS_CONFIG,
  tierById,
  type PlansConfig,
} from '../plans-config';
import {
  lockPersonTier,
  TierGrantRefusal,
  TierGrantService,
} from '../tier-grant.service';
import {
  goodsFromTerms,
  goodsOf,
  goodsToTerms,
  type PurchaseGoods,
} from './plan-purchase-goods';
import type {
  PlanPurchaseDto,
  PlanPurchaseQuoteQueryDto,
} from './plan-purchase.dto';
import {
  NOTHING_TO_UPGRADE_MESSAGE,
  PLAN_NOT_FOUND_MESSAGE,
  planPurchase,
  PurchaseRefusal,
  purchaseTitle,
  isRunning,
  type PurchasePlan,
} from './plan-purchase-rules';
import {
  PLAN_PAYMENT_KINDS,
  PLAN_PURCHASE_ROUTE,
  paymentKindOf,
  type PlanPaymentKind,
  type PurchaseTerms,
  targetIdOf,
  termsOf,
} from './plan-purchase-terms';
import type {
  PlanPurchaseGrantView,
  PlanPurchaseQuoteView,
  PlanPurchaseStatus,
  PlanPurchaseTransferView,
  PlanPurchaseView,
  PlanTransferOrderView,
} from './plan-purchase-view.type';
import {
  amountNeeded,
  EXPIRED_MESSAGE,
  lapsed,
  ORDER_STATUS,
  SETTLING_MESSAGE,
} from './plan-transfer-order';
import { PlanTransferService } from './plan-transfer.service';

export { PLAN_PURCHASE_ROUTE };

export const PURCHASE_NOT_FOUND_MESSAGE = 'We could not find that purchase.';

/**
 * What a purchase says once the plan could not be granted after the payment
 * confirmed and the money is going back (TIER-03 round 2): while the move is
 * on its way, and once the provider has confirmed it.
 */
export const CHARGE_NOT_RETURNED_NOTE =
  'The charge on your first payment is not returned.';

/**
 * What comes back is the price the hold holds (R-10: a refund returns the
 * price, never the provider's charge on the original payment), said in naira
 * so the person who was just refunded can match it to their wallet.
 */
export function refundingMessage(amountKobo: number): string {
  return `We could not give you this plan, so ${nairaText(amountKobo)} is on its way back to your wallet. ${CHARGE_NOT_RETURNED_NOTE}`;
}
export function refundedMessage(amountKobo: number): string {
  return `We could not give you this plan, so ${nairaText(amountKobo)} is back in your wallet. ${CHARGE_NOT_RETURNED_NOTE}`;
}

/** The hold's `releaseCondition` for a tier payment that is being refunded. */
export const PLAN_REFUND_CONDITION = 'plan_granted';

/** A day, in milliseconds. */
const DAY_MS = 86_400_000;

/** Payments that are paid but not yet delivered keep their claim (`openKey`). */
const OPEN_PAYMENT_STATES = [
  { status: 'pending' },
  { status: 'completed', openKey: { not: null } },
];

/**
 * Buy, renew or upgrade a tier from the wallet (task TIER-03, R-43, R-44).
 *
 * - **The payment is MONEY-17's.** A purchase is a wallet payment of kind
 *   `tier` (the plan alone) or `tier_bump` (the plan and the checkout bump's
 *   points) into WAWU's own account: it is WAWU's own sale, so there is no
 *   seller split and nothing is held (R-19 is for money owed to someone
 *   else). The provider's charge is on top, as on every purchase (R-10).
 * - **The terms are the payment's target.** `tier-founding`, `renew-plus`,
 *   `upgrade-verify-founding` (plan-purchase-terms.ts): the payment freezes
 *   its kind and target when it is claimed, so what is delivered is what was
 *   priced, and the quote (`GET /money/payments/quote`, or
 *   `GET /plans/purchases/quote`) is bound to them.
 * - **The price is the config's** (`planPurchase`, in the person's billing
 *   currency; an upgrade pays the difference of the two config prices). A
 *   person billed in dollars is refused by the payment service until a
 *   dollar wallet can pay it (NUV-09): cents are never charged as kobo.
 * - **Granted once per payment.** `onCompleted` runs in the request, and
 *   again from the payment sweep until it has succeeded, on any server. It
 *   inserts the purchase row (primary key: the payment's id), fixes the
 *   billing currency at the first purchase, grants through
 *   TierGrantService, and grants the bump's points, last, all in ONE
 *   transaction at READ COMMITTED (`fixAtFirstPurchase` needs it). A repeat
 *   finds its row and writes nothing.
 * - **One plan payment at a time per person.** The payment service allows
 *   one open payment per buyer and target; this adds one per buyer across
 *   the plan's targets, so two plans bought at once cannot both be taken.
 *   It is asked again inside the payment's claim, so of two requests at the
 *   same moment at most one goes on.
 * - **Nothing is written for a payment that is not paid.** A pending,
 *   failed or reversed payment is read from the payment itself.
 * - **A plan that cannot be granted is paid back.** If, when the payment
 *   confirms, the purchase no longer fits what the person holds (the tier an
 *   upgrade came from ended while it confirmed, another tier was granted, the
 *   currency was fixed another way), nothing is granted and the whole price
 *   goes back to the payer through MONEY-18's refund (a send from WAWU's
 *   account under our own reference, once, one way; WAWU pays the provider's
 *   charge on that move, R-31). The tier payment is not a held kind, so a
 *   `WalletHold` is written for it only here, in the same lock the grant
 *   takes, and exactly one of the two outcomes can happen to a payment: the
 *   purchase row (granted) or the hold (refunded). The delivery then returns
 *   normally, so the person is free to buy again at once.
 */
@Injectable()
export class PlanPurchaseService implements OnModuleInit {
  private readonly logger = new Logger(PlanPurchaseService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PLANS_CONFIG) private readonly config: PlansConfig,
    private readonly tiers: MakerTierService,
    private readonly billing: BillingCurrencyService,
    private readonly grants: TierGrantService,
    private readonly points: PointsService,
    private readonly payments: WalletPaymentService,
    private readonly registry: PayableRegistry,
    private readonly holds: WalletHoldService,
    private readonly transfers: PlanTransferService,
    private readonly opening: WalletOpeningService,
  ) {}

  onModuleInit(): void {
    this.assertTargetsFit();
    for (const kind of PLAN_PAYMENT_KINDS)
      this.registry.register(this.handlerFor(kind));
    this.payments.presentRoute(PLAN_PURCHASE_ROUTE, (view) =>
      this.present(view),
    );
  }

  /** A tier id too long to name a purchase in a payment target stops the boot, as a bad file does. */
  private assertTargetsFit(): void {
    const unfit = (terms: PurchaseTerms) => targetIdOf(terms) === null;
    for (const to of this.config.tiers) {
      for (const kind of ['tier', 'renew'] as const)
        if (unfit({ kind, tierId: to.id, fromTierId: null, bump: false }))
          throw new Error(
            `plans.config.json: the tier id "${to.id}" is too long to name a purchase in a payment target.`,
          );
      for (const from of this.config.tiers)
        if (
          from.id !== to.id &&
          unfit({
            kind: 'upgrade',
            tierId: to.id,
            fromTierId: from.id,
            bump: false,
          })
        )
          throw new Error(
            `plans.config.json: the tier ids "${from.id}" and "${to.id}" are too long to name an upgrade in a payment target.`,
          );
    }
  }

  // -------------------------------------------------------------------------
  // The routes
  // -------------------------------------------------------------------------

  /** The pay sheet (VF6): the purchase priced, with the wallet payment's quote. */
  async quote(
    wallet: OpenWallet,
    q: PlanPurchaseQuoteQueryDto,
  ): Promise<PlanPurchaseQuoteView> {
    const terms = await this.termsFor(wallet.wawuUserId, q);
    const targetId = this.targetOf(terms);
    const plan = await this.priced(wallet.wawuUserId, terms);
    const paymentKind = paymentKindOf(terms.bump);
    const payment = await this.payments.quote(wallet, {
      kind: paymentKind,
      targetId,
    });
    return {
      kind: terms.kind,
      tierId: terms.tierId,
      fromTierId: terms.fromTierId,
      bump: terms.bump,
      currency: plan.currency,
      planMinor: plan.planMinor,
      bumpMinor: plan.bumpMinor,
      bumpPoints: plan.bumpPoints,
      paymentKind,
      payment,
    };
  }

  /**
   * Pays for a purchase from the wallet, or confirms it for payment by bank
   * transfer (`method: transfer`, TIER-05). The answer, and every replay of
   * the request's key, is the purchase as `present` (wallet) or
   * `presentOrder` (transfer) builds it.
   */
  async buy(
    wallet: OpenWallet,
    scope: IdempotencyScope,
    dto: PlanPurchaseDto,
  ): Promise<PlanPurchaseView | PlanTransferOrderView> {
    const terms = await this.termsFor(wallet.wawuUserId, dto);
    const kind = paymentKindOf(terms.bump);
    const targetId = this.targetOf(terms);
    if (dto.method === 'transfer')
      return this.buyByTransfer(wallet, scope, dto, kind, targetId);
    const payment = await this.payments.pay(
      wallet,
      {
        kind,
        targetId,
        expectedTotalKobo: dto.expectedTotalKobo,
        quoteToken: dto.quoteToken,
      },
      scope,
    );
    // The item is now being bought from the wallet: a bank-transfer purchase of
    // the same item that is still waiting is closed (it would be a second one).
    if (payment.status !== 'failed')
      await this.transfers
        .closeWaiting(wallet.wawuUserId, targetId)
        .catch(() => undefined);
    return (
      (scope.answered as PlanPurchaseView | undefined) ?? this.present(payment)
    );
  }

  /**
   * The person chose to pay by bank transfer (VF6 "transfer details shown"):
   * the quote they saw is checked exactly as a wallet payment checks it, the
   * order is written, and the answer says where to send the money and how
   * much is still needed. Nothing is taken and nothing is held.
   */
  private async buyByTransfer(
    wallet: OpenWallet,
    scope: IdempotencyScope,
    dto: PlanPurchaseDto,
    kind: PlanPaymentKind,
    targetId: string,
  ): Promise<PlanTransferOrderView> {
    const { target, fee, availableKobo } = await this.payments.vouch(wallet, {
      kind,
      targetId,
      expectedTotalKobo: dto.expectedTotalKobo,
      quoteToken: dto.quoteToken,
    });
    const order = await this.transfers.place({
      wallet,
      kind,
      targetId,
      target,
      fee,
      availableKobo,
    });
    const view = await this.presentOrder(order, availableKobo);
    await this.transfers.answer(scope, view);
    return view as PlanTransferOrderView;
  }

  /** One purchase as it stands now. Only the buyer reads it. */
  async read(
    wawuUserId: string,
    id: string,
  ): Promise<PlanPurchaseView | PlanTransferOrderView> {
    const order = await this.transfers.find(wawuUserId, id);
    if (order) return this.presentOrder(order);
    const payment = await this.prisma.walletPayment.findFirst({
      where: {
        id,
        payerWawuUserId: wawuUserId,
        kind: { in: [...PLAN_PAYMENT_KINDS] },
      },
    });
    if (!payment) throw new MoneyError('not_found', PURCHASE_NOT_FOUND_MESSAGE);
    return this.present(this.payments.view(payment, null));
  }

  /**
   * A purchase bought by transfer as the routes answer it. While it waits, the
   * provider's available balance is read for the amount still needed (pass it
   * when it was just read); once the money landed and the wallet payment
   * exists, it is that payment's purchase under the order's id.
   */
  private async presentOrder(
    order: PlanTransferOrder,
    knownAvailableKobo?: number,
  ): Promise<PlanPurchaseView | PlanTransferOrderView> {
    const kind = order.paymentKind as PlanPaymentKind;
    const terms = termsOf(kind, order.targetId);
    if (terms === null)
      throw new Error(`Order ${order.id} is not a tier purchase.`);
    if (order.status === ORDER_STATUS.settled && order.paymentId) {
      const payment = await this.prisma.walletPayment.findUnique({
        where: { id: order.paymentId },
      });
      if (payment) return this.present(this.payments.view(payment, null));
    }
    const base = {
      id: order.id,
      kind: terms.kind,
      tierId: terms.tierId,
      fromTierId: terms.fromTierId,
      bump: terms.bump,
      method: 'transfer' as const,
      currency: PAYMENT_CURRENCY as PlanCurrency,
      amountMinor: order.priceKobo,
      payment: null,
      grant: null,
      createdAt: order.createdAt.toISOString(),
      paidAt: null,
    };
    const waiting =
      order.status === ORDER_STATUS.awaiting && !lapsed(order, new Date());
    if (waiting)
      return {
        ...base,
        status: 'awaiting_transfer',
        statusMessage: order.statusMessage,
        transfer: await this.transferView(order, knownAvailableKobo),
      };
    if (order.status === ORDER_STATUS.closed)
      return {
        ...base,
        status: 'failed',
        statusMessage: order.statusMessage,
        transfer: null,
      };
    if (order.status === ORDER_STATUS.settling || order.status === 'settled')
      return {
        ...base,
        status: 'pending',
        statusMessage: SETTLING_MESSAGE,
        transfer: null,
      };
    return {
      ...base,
      status: 'expired',
      statusMessage: order.statusMessage ?? EXPIRED_MESSAGE,
      transfer: null,
    };
  }

  /** Where to send the money and how much is still needed; the account is the person's own wallet. */
  private async transferView(
    order: PlanTransferOrder,
    knownAvailableKobo?: number,
  ): Promise<PlanPurchaseTransferView | null> {
    const wallet = await this.opening.view(order.wawuUserId);
    if (!wallet.account) return null;
    let balance: number | null = knownAvailableKobo ?? null;
    if (knownAvailableKobo === undefined) {
      const open = await this.transfers.walletOf(order.wawuUserId);
      balance = open ? await this.payments.availableOrNull(open) : null;
    }
    return {
      accountNumber: wallet.account.accountNumber,
      accountName: wallet.account.accountName,
      bankName: wallet.account.bankName,
      bankCode: wallet.account.bankCode,
      priceKobo: order.priceKobo,
      bankChargeKobo: order.providerFeeKobo,
      totalKobo: order.totalKobo,
      balanceKobo: balance,
      amountNeededKobo:
        balance === null ? null : amountNeeded(order.totalKobo, balance),
      expiresAt: order.expiresAt.toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // The payment's side: what is priced, and what is delivered
  // -------------------------------------------------------------------------

  private handlerFor(kind: PlanPaymentKind): PayableKindHandler {
    return {
      kind,
      resolve: (lookup) => this.resolve(kind, lookup),
      onCompleted: (payment) => this.deliver(payment),
    };
  }

  /** Prices the terms in the target for the payer, or refuses them. Moves nothing. */
  private async resolve(
    kind: PlanPaymentKind,
    lookup: PayableLookup,
  ): Promise<PayableTarget> {
    const terms = termsOf(kind, lookup.targetId);
    if (terms === null)
      throw new MoneyError('target_not_found', PLAN_NOT_FOUND_MESSAGE);
    const plan = await this.priced(lookup.payerWawuUserId, terms);
    await this.refuseOtherOpenPayment(
      lookup.payerWawuUserId,
      kind,
      lookup.targetId,
    );
    return {
      title: purchaseTitle(plan),
      priceKobo: plan.totalMinor,
      payee: null,
      currency: plan.currency,
      // The goods the quote promises: the quote token is bound to them and the
      // payment keeps them, so the grant gives what was quoted (TIER-06 round 2).
      terms: goodsToTerms(goodsOf(plan, this.config.points.boughtExpiryDays)),
    };
  }

  private async priced(
    wawuUserId: string,
    terms: PurchaseTerms,
  ): Promise<PurchasePlan> {
    const [held, billing] = await Promise.all([
      this.tiers.tierOf(wawuUserId),
      this.billing.resolve(wawuUserId, {}),
    ]);
    try {
      return planPurchase(this.config, billing.currency, held, terms);
    } catch (e) {
      if (e instanceof PurchaseRefusal) throw new MoneyError(e.code, e.message);
      throw e;
    }
  }

  /**
   * One plan payment at a time per person: a payment for another target (or
   * the same target with or without the bump) that is still confirming, or
   * paid and not yet opened, is `409 payment_in_progress` with its id. The
   * payment's own row is not it (same kind and target).
   */
  private async refuseOtherOpenPayment(
    wawuUserId: string,
    kind: PlanPaymentKind,
    targetId: string,
  ): Promise<void> {
    const other = await this.prisma.walletPayment.findFirst({
      where: {
        payerWawuUserId: wawuUserId,
        kind: { in: [...PLAN_PAYMENT_KINDS] },
        OR: OPEN_PAYMENT_STATES,
        NOT: { kind, targetId },
      },
      select: { id: true, status: true },
    });
    if (other)
      throw new MoneyError(
        'payment_in_progress',
        other.status === 'completed'
          ? FINISHING_MESSAGE
          : STILL_CONFIRMING_MESSAGE,
        { paymentId: other.id },
      );
  }

  /**
   * The payment is confirmed: grant what it bought, once. Idempotent and safe
   * to run on two servers at once (see the class comment). A purchase that no
   * longer fits what the person holds (their tier changed, or the one an
   * upgrade came from ended, while the payment was confirming) is NOT
   * granted: nothing is written for the grant and the whole price goes back
   * to the payer (`refund`), once. Anything else that goes wrong throws, and
   * the payment service tries again and then sends it to review with the
   * money safe in WAWU's account.
   */
  private async deliver(payment: CompletedPayment): Promise<void> {
    const terms = termsOf(payment.kind, payment.targetId);
    if (terms === null)
      throw new Error(`Payment ${payment.paymentId} names no tier terms.`);
    if (
      !Number.isSafeInteger(payment.priceKobo) ||
      payment.priceKobo < 1 ||
      payment.priceKobo > INT4_MAX
    )
      throw new Error(`Payment ${payment.paymentId} has no usable price.`);
    // What the payment was quoted with; null for one claimed before the goods
    // were kept, which is granted from the plan as it stands.
    const goods = goodsFromTerms(payment.terms);
    const refusal = await this.grantOnce(payment, terms, goods);
    if (refusal !== null) await this.refund(payment, refusal);
  }

  /**
   * The grant, in one READ COMMITTED transaction (Prisma's default, and what
   * `fixAtFirstPurchase` needs). Null when the payment was granted, now or by
   * an earlier delivery; otherwise why it cannot be, with nothing written (a
   * refusal rolls the transaction back).
   */
  private async grantOnce(
    payment: CompletedPayment,
    terms: PurchaseTerms,
    goods: PurchaseGoods | null,
  ): Promise<string | null> {
    const tier = tierById(this.config, terms.tierId);
    if (tier === null)
      return `The plans file names no tier "${terms.tierId}" any more.`;

    const wawuUserId = payment.payerWawuUserId;
    const sourceRef = payment.paymentId;
    const now = new Date();
    try {
      await this.prisma.$transaction(async (tx) => {
        await lockPersonTier(tx, wawuUserId);
        // A payment already being paid back is never granted, whatever has
        // changed since: the refund and the grant are decided under this lock
        // and exclude each other.
        const paidBack = await tx.walletHold.findUnique({
          where: { paymentId: sourceRef },
          select: { id: true },
        });
        if (paidBack)
          throw new TierGrantRefusal(
            'This payment is being paid back, so it is not granted.',
          );
        // The once-per-payment gate: the row's key is the payment's id.
        const { count } = await tx.makerPurchase.createMany({
          data: [
            {
              paymentRef: sourceRef,
              wawuUserId,
              kind: terms.kind,
              tierId: terms.tierId,
              fromTierId: terms.fromTierId,
              bump: terms.bump,
              currency: PAYMENT_CURRENCY,
              amountMinor: payment.priceKobo,
            },
          ],
          skipDuplicates: true,
        });
        if (count === 0) return;

        const fixed = await this.billing.fixAtFirstPurchase(
          { wawuUserId, purchaseRef: sourceRef },
          tx,
        );
        if (fixed !== PAYMENT_CURRENCY)
          throw new TierGrantRefusal(
            'The person is billed in another currency than the one that was paid.',
          );

        const held = await tx.makerTier.findUnique({ where: { wawuUserId } });
        const running =
          held !== null && held.activeUntil.getTime() > now.getTime();
        if (terms.kind === 'upgrade') {
          await this.grants.upgrade(tx, {
            wawuUserId,
            fromTierId: terms.fromTierId ?? '',
            tierId: terms.tierId,
            sourceRef,
            ...(goods === null ? {} : { goods }),
            now,
          });
        } else {
          // A first purchase meets a tier that began to run while it was
          // confirming only when it is the same tier (then it extends it, as
          // a renewal); a renewal needs the tier it renews.
          const fits =
            terms.kind === 'renew'
              ? held !== null && held.tierId === terms.tierId
              : !running || held.tierId === terms.tierId;
          if (!fits)
            throw new TierGrantRefusal(
              'The person holds another tier than the one this purchase was priced for.',
            );
          await this.grants.grant(tx, {
            wawuUserId,
            tierId: terms.tierId,
            sourceRef,
            ...(goods === null ? {} : { goods }),
            now,
          });
        }
        // The points of the checkout bump: a bought lot, last in the transaction.
        if (terms.bump)
          await this.points.grant(
            {
              wawuUserId,
              source: 'bump',
              sourceRef,
              points: goods ? goods.bumpPoints : this.bumpPoints(),
              expiresAt: new Date(
                now.getTime() +
                  (goods
                    ? goods.boughtExpiryDays
                    : this.config.points.boughtExpiryDays) *
                    DAY_MS,
              ),
            },
            { tx, now },
          );
      });
      return null;
    } catch (e) {
      if (e instanceof TierGrantRefusal) return e.message;
      throw e;
    }
  }

  /**
   * Pays a payment that cannot be granted back to its payer, in full, through
   * MONEY-18's refund: a `WalletHold` is written for it (the tier payment is
   * not a held kind, so it has none), then refunded. Under the person's tier
   * lock, so it excludes the grant: a delivery that granted the payment first
   * leaves nothing to pay back. Safe to run again, and on two servers: the
   * hold is one row per payment, the refund is asked once, and the move goes
   * out under one reference of ours that the provider refuses to repeat.
   */
  private async refund(payment: CompletedPayment, why: string): Promise<void> {
    const decided = await this.prisma.$transaction(async (tx) => {
      await lockPersonTier(tx, payment.payerWawuUserId);
      const granted = await tx.makerPurchase.findUnique({
        where: { paymentRef: payment.paymentId },
        select: { paymentRef: true },
      });
      if (granted) return false;
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
            releaseCondition: PLAN_REFUND_CONDITION,
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
      return true;
    });
    if (!decided) return;
    this.logger.warn(
      `payment ${payment.paymentId}: the plan could not be granted (${why}); the price is being refunded`,
    );
    await this.holds.refund(
      { paymentId: payment.paymentId },
      `plan not granted: ${why}`,
    );
  }

  private bumpPoints(): number {
    return countIn(this.config.checkoutBump.points, PAYMENT_CURRENCY);
  }

  // -------------------------------------------------------------------------
  // What the routes answer
  // -------------------------------------------------------------------------

  /** The purchase a payment is, as the routes answer it and the key stores it. */
  async present(view: PaymentView): Promise<PlanPurchaseView> {
    const terms = termsOf(view.kind, view.targetId);
    if (terms === null)
      throw new Error(`Payment ${view.id} is not a tier payment.`);
    const row = await this.prisma.makerPurchase.findUnique({
      where: { paymentRef: view.id },
    });
    // Only a payment that could not be granted has a hold (the tier payment
    // is not a held kind): its price is going back, or has gone back.
    const payback = row
      ? null
      : await this.prisma.walletHold.findUnique({
          where: { paymentId: view.id },
          select: { status: true, amountKobo: true },
        });
    // A payment the settlement of a bank-transfer purchase made is that
    // purchase's: it keeps the id the person was given while it waited.
    const order = await this.transfers.byPayment(view.id);
    return {
      id: order?.id ?? view.id,
      kind: terms.kind,
      tierId: terms.tierId,
      fromTierId: terms.fromTierId,
      bump: terms.bump,
      method: order ? 'transfer' : 'wallet',
      currency: row?.currency ?? PAYMENT_CURRENCY,
      amountMinor: row?.amountMinor ?? view.priceKobo,
      status: row ? 'paid' : payback ? 'refunded' : statusOf(view.status),
      statusMessage: row
        ? null
        : payback
          ? payback.status === 'refunded'
            ? refundedMessage(Number(payback.amountKobo))
            : refundingMessage(Number(payback.amountKobo))
          : (view.failureReason ?? view.statusMessage),
      payment: view,
      grant: row ? await this.grantView(row.wawuUserId, row.paymentRef) : null,
      createdAt: view.createdAt,
      paidAt: row ? row.createdAt.toISOString() : null,
    };
  }

  /** What a paid purchase gave: the tier as it stands, and the lots and pass this payment issued. */
  private async grantView(
    wawuUserId: string,
    paymentRef: string,
  ): Promise<PlanPurchaseGrantView | null> {
    try {
      const [held, bonus, bump, pass] = await Promise.all([
        this.tiers.tierOf(wawuUserId),
        this.prisma.pointLot.findUnique({
          where: {
            source_sourceRef: { source: 'tier_bonus', sourceRef: paymentRef },
          },
        }),
        this.prisma.pointLot.findUnique({
          where: {
            source_sourceRef: { source: 'bump', sourceRef: paymentRef },
          },
        }),
        this.prisma.eventPass.findUnique({
          where: { purchaseRef: paymentRef },
        }),
      ]);
      if (held.tierId === null || !held.activeFrom || !held.activeUntil)
        return null;
      const issued = pass
        ? this.config.eventPasses.find((p) => p.id === pass.type)
        : undefined;
      return {
        tier: {
          id: held.tierId,
          name: held.tier?.name ?? null,
          badge: held.tier ? { ...held.tier.badge } : null,
        },
        activeFrom: held.activeFrom.toISOString(),
        activeUntil: held.activeUntil.toISOString(),
        productsAllowed: held.productsAllowed,
        bonusPoints: bonus?.quantity ?? 0,
        bonusPointsExpireAt: bonus?.expiresAt.toISOString() ?? null,
        bumpPoints: bump?.quantity ?? 0,
        bumpPointsExpireAt: bump?.expiresAt.toISOString() ?? null,
        eventPass: issued ? { id: issued.id, name: issued.name } : null,
        firstVoiceIntroIncluded: held.voiceIntroIncluded,
      };
    } catch (e) {
      // The purchase is paid whatever this read says; the next read has it.
      this.logger.warn(
        `purchase ${paymentRef}: what it gave could not be read (${e instanceof Error ? e.name : 'error'})`,
      );
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Pieces
  // -------------------------------------------------------------------------

  /** The terms of a request. An upgrade moves from the tier the person runs now. */
  private async termsFor(
    wawuUserId: string,
    req: Pick<PlanPurchaseQuoteQueryDto, 'kind' | 'tierId' | 'bump'>,
  ): Promise<PurchaseTerms> {
    const bump = req.bump === true;
    if (req.kind !== 'upgrade')
      return { kind: req.kind, tierId: req.tierId, fromTierId: null, bump };
    const held = await this.tiers.tierOf(wawuUserId);
    if (!isRunning(held) || held.tierId === null)
      throw new MoneyError('target_not_payable', NOTHING_TO_UPGRADE_MESSAGE);
    return {
      kind: 'upgrade',
      tierId: req.tierId,
      fromTierId: held.tierId,
      bump,
    };
  }

  private targetOf(terms: PurchaseTerms): string {
    const id = targetIdOf(terms);
    if (id === null)
      throw new MoneyError('target_not_found', PLAN_NOT_FOUND_MESSAGE);
    return id;
  }
}

/** A payment that is not paid, as a purchase status. */
function statusOf(status: PaymentStatus): PlanPurchaseStatus {
  switch (status) {
    case 'failed':
      return 'failed';
    case 'reversed':
      return 'reversed';
    default:
      return 'pending';
  }
}
