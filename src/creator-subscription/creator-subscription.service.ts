import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import type { Paginated } from '../common/interceptors/response.interceptor';
import type { CreatorSubscriptionResponse } from '../common/types/creator-subscription.type';
import type { CreatorTier } from '../../generated/prisma/enums';
import {
  FLUTTERWAVE_CLIENT,
  type FlutterwaveClient,
} from './flutterwave-client.interface';
import type { SubscribeDto } from './dto/subscribe.dto';
import type { VerifySubscriptionDto } from './dto/verify-subscription.dto';
import type { UpdateCardDto } from './dto/update-card.dto';

/**
 * Annual subscription prices, naira — confirmed against
 * design/screens/WAWU Subscription Management.dc.html ("Basic is ₦5,999",
 * "Pro, one year ₦18,999"). Never accepted from the client
 * (conventions.md § Identity & format canon).
 */
const PRICE_TABLE: Record<CreatorTier, number> = {
  basic: 5999,
  pro: 18999,
};

/** Pro-tier commission override (CLAUDE.md: 85/15 standard, 90/10 Pro). */
const PRO_COMMISSION_RATE_OVERRIDE = 0.1;

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A past_due subscription gets this many total renewal attempts (the
 * initial failure + retries) before it lapses to `expired`. Confirmed
 * against the design's own copy ("We will try twice more... 11 days before
 * Pro lapses" — 1 initial failure + 2 retries = 3 total attempts).
 */
const MAX_RENEWAL_ATTEMPTS = 3;

export interface FlutterwaveConfigResponse {
  flutterwaveConfig: {
    txRef: string;
    amount: number;
    currency: 'NGN';
    publicKey: string;
  };
}

type PendingAttemptKind = 'subscribe' | 'upgrade';

interface PendingAttempt {
  kind: PendingAttemptKind;
  wawuUserId: string;
  tier: CreatorTier;
  planId: string;
}

/**
 * CreatorSubscription resource — registry.json "CreatorSubscription".
 * Recurring annual billing via Flutterwave's Payment Plans API. See
 * flutterwave-client.interface.ts's doc comment for the createOrReusePlan /
 * chargeSavedCard extensions this resource needs beyond the base
 * client-charge + server-verify pattern.
 *
 * JUDGMENT — `pendingAttempts` in-memory map: `SubscriptionStatus` (the
 * frozen schema's only status enum for this model) has no "pending" value,
 * unlike Purchase/CreditPurchase's `TransactionStatus` which does — so,
 * unlike those resources, a subscribe/upgrade attempt cannot be recorded as
 * a not-yet-verified CreatorSubscription row (there is exactly one row per
 * creator, keyed by the frozen `creatorWawuId @id`, and writing a
 * half-finished row before payment is confirmed would either overwrite a
 * real existing subscription or violate the "only verify flips
 * subscriptionPaid" rule). This service instead bridges POST
 * (subscribe/upgrade) -> POST /verify with a request-scoped-to-process
 * in-memory map keyed by `tx_ref`, mirroring how MockFlutterwaveAdapter
 * itself already keeps in-memory state keyed by txRef for the identical
 * reason. This is a process-lifetime bridge, not durable storage — a
 * server restart between initiating and verifying a charge would lose the
 * pending attempt (the user would see a 404 on verify and would need to
 * restart the subscribe/upgrade flow). Acceptable for this build: the
 * webhook-driven reconciliation infrastructure that would remove this
 * limitation entirely is explicitly deferred (task brief).
 */
@Injectable()
export class CreatorSubscriptionService {
  private readonly pendingAttempts = new Map<string, PendingAttempt>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(FLUTTERWAVE_CLIENT) private readonly flutterwave: FlutterwaveClient,
  ) {}

  private toResponse(row: {
    creatorWawuId: string;
    tier: CreatorTier;
    status: string;
    commissionRateOverride: { toNumber(): number } | null;
    flutterwaveCustomerRef: string | null;
    flutterwavePlanId: string | null;
    currentPeriodEnd: Date;
    renewalAttempts: number;
    cancelsAt: Date | null;
    cardLast4: string | null;
  }): CreatorSubscriptionResponse {
    return {
      ...row,
      commissionRateOverride: row.commissionRateOverride
        ? row.commissionRateOverride.toNumber()
        : null,
    } as CreatorSubscriptionResponse;
  }

  /**
   * GET /creator-subscription. JUDGMENT: 404 (not an empty-shape 200) when
   * the caller has never subscribed. The caller has already passed
   * CreatorAccountGuard here (accountType === 'creator'), so a missing row
   * specifically means "creator account, never subscribed" — a real,
   * meaningful absence worth a 404, not a synthetic empty object that would
   * be awkward to type against CreatorSubscriptionResponse's non-nullable
   * `tier`/`status`/`currentPeriodEnd` fields.
   */
  async getSubscription(
    creatorWawuId: string,
  ): Promise<CreatorSubscriptionResponse> {
    const row = await this.prisma.creatorSubscription.findUnique({
      where: { creatorWawuId },
    });
    if (!row) {
      throw new NotFoundException(
        'No subscription yet — subscribe via POST /creator-subscription first.',
      );
    }
    return this.toResponse(row);
  }

  /** POST /creator-subscription — first-time-subscribe path (roles: any). */
  async subscribe(
    wawuUserId: string,
    dto: SubscribeDto,
  ): Promise<FlutterwaveConfigResponse> {
    const existing = await this.prisma.creatorSubscription.findUnique({
      where: { creatorWawuId: wawuUserId },
    });
    if (
      existing &&
      (existing.status === 'active' || existing.status === 'past_due')
    ) {
      throw new BadRequestException(
        'Already subscribed — use /upgrade, /downgrade, or /retry-payment instead.',
      );
    }

    const amount = PRICE_TABLE[dto.tier];
    const plan = await this.flutterwave.createOrReusePlan({
      tier: dto.tier,
      amount,
    });
    const charge = this.flutterwave.initCharge({
      amount,
      purpose: `subscribe-${dto.tier}`,
      wawuUserId,
      planId: plan.planId,
    });

    this.pendingAttempts.set(charge.txRef, {
      kind: 'subscribe',
      wawuUserId,
      tier: dto.tier,
      planId: plan.planId,
    });

    return {
      flutterwaveConfig: {
        txRef: charge.txRef,
        amount: charge.amount,
        currency: charge.currency,
        publicKey: charge.publicKey,
      },
    };
  }

  /** POST /creator-subscription/verify (roles: any — completes subscribe or upgrade). */
  async verify(
    wawuUserId: string,
    dto: VerifySubscriptionDto,
  ): Promise<CreatorSubscriptionResponse> {
    const pending = this.pendingAttempts.get(dto.tx_ref);
    if (!pending || pending.wawuUserId !== wawuUserId) {
      throw new NotFoundException(
        'No matching subscription attempt found for this reference',
      );
    }

    const result = await this.flutterwave.verifyCharge({
      transactionId: dto.transaction_id,
      txRef: dto.tx_ref,
    });

    const verified =
      result.status === 'successful' &&
      result.currency === 'NGN' &&
      result.txRef === dto.tx_ref;

    this.pendingAttempts.delete(dto.tx_ref);

    if (!verified) {
      throw new BadRequestException('Payment verification failed');
    }

    const now = new Date();

    if (pending.kind === 'subscribe') {
      const row = await this.prisma.creatorSubscription.upsert({
        where: { creatorWawuId: wawuUserId },
        create: {
          creatorWawuId: wawuUserId,
          tier: pending.tier,
          status: 'active',
          commissionRateOverride:
            pending.tier === 'pro' ? PRO_COMMISSION_RATE_OVERRIDE : null,
          flutterwaveCustomerRef: `flw-cust-${wawuUserId}`,
          flutterwavePlanId: pending.planId,
          currentPeriodEnd: new Date(now.getTime() + ONE_YEAR_MS),
          renewalAttempts: 0,
          cancelsAt: null,
          cardLast4: result.cardLast4 ?? null,
        },
        update: {
          tier: pending.tier,
          status: 'active',
          commissionRateOverride:
            pending.tier === 'pro' ? PRO_COMMISSION_RATE_OVERRIDE : null,
          flutterwavePlanId: pending.planId,
          currentPeriodEnd: new Date(now.getTime() + ONE_YEAR_MS),
          renewalAttempts: 0,
          cancelsAt: null,
          cardLast4: result.cardLast4 ?? undefined,
        },
      });

      // This is the ONLY code path allowed to set CreatorState.subscriptionPaid
      // = true (task brief — no other dev-only toggle exists in this
      // resource). CreatorState may not exist yet for a first-time
      // subscriber (creating it here, not in UserProfile/CreatorState's own
      // resources, mirrors how CreditPurchase.verifyPurchase is the write-
      // path originator for CreditsState).
      await this.prisma.creatorState.upsert({
        where: { wawuUserId },
        create: {
          wawuUserId,
          tier: pending.tier,
          subscriptionPaid: true,
          kycStatus: 'pending',
          slotsUsed: 0,
          dmPrice: null,
          dmEnabled: false,
        },
        update: {
          tier: pending.tier,
          subscriptionPaid: true,
        },
      });

      return this.toResponse(row);
    }

    // pending.kind === 'upgrade'
    const row = await this.prisma.creatorSubscription.update({
      where: { creatorWawuId: wawuUserId },
      data: {
        tier: 'pro',
        status: 'active',
        commissionRateOverride: PRO_COMMISSION_RATE_OVERRIDE,
        flutterwavePlanId: pending.planId,
        cardLast4: result.cardLast4 ?? undefined,
        // currentPeriodEnd is deliberately untouched — upgrading keeps the
        // existing annual anniversary; only the price paid today (prorated)
        // and future renewal amount change. See upgrade()'s doc comment.
      },
    });

    await this.prisma.creatorState.update({
      where: { wawuUserId },
      data: { tier: 'pro' },
    });

    return this.toResponse(row);
  }

  /**
   * POST /creator-subscription/upgrade — basic -> pro, prorated charge.
   *
   * Proration formula (documented judgment call, confirmed against the
   * design's own worked example — Basic ₦5,999/yr, Pro ₦18,999/yr, "Credit
   * for the rest of your Basic year" then "Due today"):
   *
   *   daysRemaining = ceil((currentPeriodEnd - now) / 1 day), clamped to [0, 365]
   *   credit        = round(daysRemaining / 365 * BASIC_ANNUAL_PRICE)
   *   dueToday      = max(PRO_ANNUAL_PRICE - credit, 1)
   *
   * i.e. a straight-line credit for the unused portion of the current
   * Basic year, applied against the full Pro annual price. Floored at ₦1
   * (never a ₦0 charge) rather than allowing a zero-amount Flutterwave
   * charge in the rare case the period is already essentially over.
   */
  async upgrade(creatorWawuId: string): Promise<FlutterwaveConfigResponse> {
    const existing = await this.prisma.creatorSubscription.findUnique({
      where: { creatorWawuId },
    });
    if (!existing) {
      throw new NotFoundException(
        'No subscription yet — subscribe via POST /creator-subscription first.',
      );
    }
    if (existing.tier === 'pro') {
      throw new BadRequestException('This subscription is already Pro.');
    }
    if (existing.status !== 'active') {
      throw new BadRequestException(
        'Only an active subscription can be upgraded.',
      );
    }

    const now = new Date();
    const msRemaining = existing.currentPeriodEnd.getTime() - now.getTime();
    const daysRemaining = Math.min(
      365,
      Math.max(0, Math.ceil(msRemaining / ONE_DAY_MS)),
    );
    const credit = Math.round((daysRemaining / 365) * PRICE_TABLE.basic);
    const dueToday = Math.max(PRICE_TABLE.pro - credit, 1);

    const plan = await this.flutterwave.createOrReusePlan({
      tier: 'pro',
      amount: PRICE_TABLE.pro,
    });
    const charge = this.flutterwave.initCharge({
      amount: dueToday,
      purpose: 'upgrade-pro',
      wawuUserId: creatorWawuId,
      planId: plan.planId,
    });

    this.pendingAttempts.set(charge.txRef, {
      kind: 'upgrade',
      wawuUserId: creatorWawuId,
      tier: 'pro',
      planId: plan.planId,
    });

    return {
      flutterwaveConfig: {
        txRef: charge.txRef,
        amount: charge.amount,
        currency: charge.currency,
        publicKey: charge.publicKey,
      },
    };
  }

  /**
   * POST /creator-subscription/downgrade — pro -> basic, "takes effect at
   * period end (no refund)".
   *
   * JUDGMENT / documented gap: the frozen CreatorSubscription model has no
   * field to hold a *scheduled future* tier (only `cancelsAt`, which is
   * specifically for full cancellation via DELETE — reusing it here would
   * make a downgrade indistinguishable from a full cancellation to any
   * client reading the row, which would be actively misleading). Actually
   * applying "basic at period end" therefore requires either a schema
   * column this build cannot add (frozen schema) or the renewal-
   * reconciliation cron, which the task brief explicitly defers to a later
   * pass. This endpoint validates preconditions and returns the row
   * unchanged (still Pro, still billed at the Pro rate/split until period
   * end, exactly as promised — "no refund" cuts both ways: no partial
   * Basic-rate credit is given now either). Completing the actual tier
   * flip at `currentPeriodEnd` is out of scope here and is called out
   * again in this build's final report as a follow-up dependency on the
   * deferred cron.
   */
  async downgrade(creatorWawuId: string): Promise<CreatorSubscriptionResponse> {
    const existing = await this.prisma.creatorSubscription.findUnique({
      where: { creatorWawuId },
    });
    if (!existing) {
      throw new NotFoundException(
        'No subscription yet — subscribe via POST /creator-subscription first.',
      );
    }
    if (existing.tier !== 'pro') {
      throw new BadRequestException('This subscription is already Basic.');
    }
    if (existing.status !== 'active') {
      throw new BadRequestException(
        'Only an active subscription can be downgraded.',
      );
    }

    return this.toResponse(existing);
  }

  /**
   * POST /creator-subscription/retry-payment — re-attempts the currently-
   * failing renewal charge for a past_due subscription.
   *
   * JUDGMENT: unlike subscribe/upgrade, this charges the card already on
   * file synchronously via `chargeSavedCard` (no client SDK popup — that
   * is the entire point of a "retry", the creator does not re-enter card
   * details) and resolves the subscription's status in the same request,
   * rather than going through the pendingAttempts -> /verify bridge. The
   * returned `flutterwaveConfig` is a receipt echo (txRef/amount/currency/
   * publicKey) for the client to display, not something requiring a
   * further /verify call.
   */
  async retryPayment(
    creatorWawuId: string,
  ): Promise<FlutterwaveConfigResponse> {
    const existing = await this.prisma.creatorSubscription.findUnique({
      where: { creatorWawuId },
    });
    if (!existing) {
      throw new NotFoundException(
        'No subscription yet — subscribe via POST /creator-subscription first.',
      );
    }
    if (existing.status !== 'past_due') {
      throw new BadRequestException(
        'This subscription is not currently past due.',
      );
    }

    const amount = PRICE_TABLE[existing.tier];
    const result = await this.flutterwave.chargeSavedCard({
      flutterwaveCustomerRef: existing.flutterwaveCustomerRef,
      amount,
      purpose: 'retry-payment',
    });

    if (result.status === 'successful') {
      await this.prisma.creatorSubscription.update({
        where: { creatorWawuId },
        data: {
          status: 'active',
          currentPeriodEnd: new Date(Date.now() + ONE_YEAR_MS),
          renewalAttempts: 0,
        },
      });
      return {
        flutterwaveConfig: {
          txRef: result.txRef,
          amount: result.amount,
          currency: 'NGN',
          publicKey: result.publicKey,
        },
      };
    }

    const renewalAttempts = existing.renewalAttempts + 1;
    const status =
      renewalAttempts >= MAX_RENEWAL_ATTEMPTS ? 'expired' : 'past_due';
    await this.prisma.creatorSubscription.update({
      where: { creatorWawuId },
      data: { renewalAttempts, status },
    });

    throw new BadRequestException(
      'Retry payment failed — the card on file was declined again.',
    );
  }

  /**
   * DELETE /creator-subscription — cancelPro. `cancelsAt = currentPeriodEnd`,
   * status stays `active` until period end (does NOT immediately
   * deactivate). Idempotent: calling this again once `cancelsAt` is already
   * set is a no-op that returns the current row, rather than erroring.
   */
  async cancel(creatorWawuId: string): Promise<CreatorSubscriptionResponse> {
    const existing = await this.prisma.creatorSubscription.findUnique({
      where: { creatorWawuId },
    });
    if (!existing) {
      throw new NotFoundException(
        'No subscription yet — subscribe via POST /creator-subscription first.',
      );
    }
    if (existing.status === 'cancelled' || existing.status === 'expired') {
      throw new BadRequestException('This subscription is not active.');
    }
    if (existing.cancelsAt) {
      return this.toResponse(existing);
    }

    const row = await this.prisma.creatorSubscription.update({
      where: { creatorWawuId },
      data: { cancelsAt: existing.currentPeriodEnd },
    });
    return this.toResponse(row);
  }

  /**
   * PATCH /creator-subscription/card. JUDGMENT: no Flutterwave network call
   * here — associating a future-renewal card is not itself a charge (that
   * only happens at the next renewal/retry), so there is nothing to
   * client-charge or server-verify. `cardLast4` is derived directly from
   * the token's trailing 4 characters; a real Flutterwave tokenized card
   * would be validated implicitly the next time it is actually charged
   * (retry-payment / the deferred renewal cron), consistent with this
   * resource's existing client-charge + server-verify boundary rather than
   * inventing a third network call shape for this one field.
   */
  async updateCard(
    creatorWawuId: string,
    dto: UpdateCardDto,
  ): Promise<{ last4: string }> {
    const existing = await this.prisma.creatorSubscription.findUnique({
      where: { creatorWawuId },
    });
    if (!existing) {
      throw new NotFoundException(
        'No subscription yet — subscribe via POST /creator-subscription first.',
      );
    }

    const last4 = dto.flutterwaveCardToken.slice(-4);
    await this.prisma.creatorSubscription.update({
      where: { creatorWawuId },
      data: { cardLast4: last4 },
    });
    return { last4 };
  }

  /**
   * GET /creator-subscription/billing-history.
   *
   * JUDGMENT / documented gap: the frozen schema has no dedicated
   * billing-history/ledger table for CreatorSubscription (confirmed against
   * prisma/schema.prisma's own doc comment on this model), and the existing
   * Purchase model's `PurchaseType` enum only has `content` | `tip` — it
   * cannot represent a subscription charge without either misusing an
   * unrelated type value or altering the frozen enum, neither of which is
   * in scope. There is therefore genuinely nothing persisted to page
   * through yet. This returns an empty-but-correctly-shaped paginated
   * response rather than inventing a new table or misusing an existing one.
   */
  listBillingHistory(
    _creatorWawuId: string,
    page: number,
    perPage: number,
  ): Paginated<never> {
    return { items: [], currentPage: page, perPage, total: 0 };
  }
}
