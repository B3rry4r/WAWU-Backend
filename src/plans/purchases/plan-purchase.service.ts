import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { OpenWallet } from '../../money/gate/wallet-gate';
import { MoneyError } from '../../money/money-error';
import type { PaymentStatus, PaymentView } from '../../money/money-view.type';
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
import { BillingCurrencyService } from '../billing-currency.service';
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
  PlanPurchaseView,
} from './plan-purchase-view.type';

/** The route a purchase's Idempotency-Key is scoped to. */
export const PLAN_PURCHASE_ROUTE = 'POST plans/purchases';

export const PURCHASE_NOT_FOUND_MESSAGE = 'We could not find that purchase.';

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
   * Pays for a purchase from the wallet. The answer, and every replay of the
   * request's key, is the purchase as `present` builds it.
   */
  async buy(
    wallet: OpenWallet,
    scope: IdempotencyScope,
    dto: PlanPurchaseDto,
  ): Promise<PlanPurchaseView> {
    const terms = await this.termsFor(wallet.wawuUserId, dto);
    const payment = await this.payments.pay(
      wallet,
      {
        kind: paymentKindOf(terms.bump),
        targetId: this.targetOf(terms),
        expectedTotalKobo: dto.expectedTotalKobo,
        quoteToken: dto.quoteToken,
      },
      scope,
    );
    return (
      (scope.answered as PlanPurchaseView | undefined) ?? this.present(payment)
    );
  }

  /** One purchase as it stands now. Only the buyer reads it. */
  async read(wawuUserId: string, id: string): Promise<PlanPurchaseView> {
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
   * longer fits what the person holds (their tier changed while the payment
   * was confirming) is NOT granted: it throws, the payment service tries
   * again and then sends it to review with the money safe in WAWU's account.
   */
  private async deliver(payment: CompletedPayment): Promise<void> {
    const terms = termsOf(payment.kind, payment.targetId);
    if (terms === null)
      throw new Error(`Payment ${payment.paymentId} names no tier terms.`);
    const tier = tierById(this.config, terms.tierId);
    if (tier === null)
      throw new Error(`The plans file names no tier "${terms.tierId}".`);
    if (
      !Number.isSafeInteger(payment.priceKobo) ||
      payment.priceKobo < 1 ||
      payment.priceKobo > INT4_MAX
    )
      throw new Error(`Payment ${payment.paymentId} has no usable price.`);

    const wawuUserId = payment.payerWawuUserId;
    const sourceRef = payment.paymentId;
    const now = new Date();
    // READ COMMITTED, Prisma's default and what `fixAtFirstPurchase` needs.
    await this.prisma.$transaction(async (tx) => {
      await lockPersonTier(tx, wawuUserId);
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
          now,
        });
      } else {
        // A first purchase meets a tier that began to run while it was
        // confirming only when it is the same tier (then it extends it, as a
        // renewal); a renewal needs the tier it renews.
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
            points: this.bumpPoints(),
            expiresAt: new Date(
              now.getTime() + this.config.points.boughtExpiryDays * DAY_MS,
            ),
          },
          { tx, now },
        );
    });
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
    return {
      id: view.id,
      kind: terms.kind,
      tierId: terms.tierId,
      fromTierId: terms.fromTierId,
      bump: terms.bump,
      method: 'wallet',
      currency: row?.currency ?? PAYMENT_CURRENCY,
      amountMinor: row?.amountMinor ?? view.priceKobo,
      status: row ? 'paid' : statusOf(view.status),
      statusMessage: row ? null : (view.failureReason ?? view.statusMessage),
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
