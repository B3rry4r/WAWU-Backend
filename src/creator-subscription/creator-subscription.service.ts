import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import type { Paginated } from '../common/interceptors/response.interceptor';
import type {
  CreatorSubscription as CreatorSubscriptionRow,
  CreatorSubscriptionResponse,
} from '../common/types/creator-subscription.type';
import { AccountType } from '../../generated/prisma/enums';
import type { CreatorTier } from '../../generated/prisma/enums';
import {
  FLUTTERWAVE_CLIENT,
  type FlutterwaveClient,
} from './flutterwave-client.interface';
import type { SubscribeDto } from './dto/subscribe.dto';
import type { VerifySubscriptionDto } from './dto/verify-subscription.dto';
import type { UpdateCardDto } from './dto/update-card.dto';
import { NotificationService } from '../notification/notification.service';

/**
 * Annual subscription prices, naira. Never accepted from the client
 * (conventions.md § Identity & format canon).
 *
 * Pro dropped from ₦18,999 to ₦14,999 when Pro Max was introduced above it.
 * Price is read here at charge time rather than stored on the subscription,
 * so an existing Pro subscriber is simply billed the new figure at their next
 * renewal — there is nothing to backfill. What IS stored per row is the
 * commission rate they were sold (`commissionRateOverride`), which is
 * untouched by a price change.
 */
const PRICE_TABLE: Record<CreatorTier, number> = {
  basic: 5999,
  pro: 14999,
  pro_max: 29999,
};

/**
 * Tiers in ascending order. Upgrade and downgrade both read this rather than
 * comparing strings, so adding a fourth tier later does not mean hunting for
 * every `=== 'pro'` in the file.
 */
const TIER_ORDER: CreatorTier[] = ['basic', 'pro', 'pro_max'];

export function tierRank(tier: CreatorTier): number {
  return TIER_ORDER.indexOf(tier);
}

/**
 * The paid-tier commission override (CLAUDE.md: 85/15 standard, 90/10 Pro).
 * Pro Max keeps the same 90/10 — it sells more services, not a better split,
 * and inventing a third rate would be inventing a rate.
 */
const PRO_COMMISSION_RATE_OVERRIDE = 0.1;

/**
 * The commission override a tier carries. Basic is billed at the standard
 * 85/15 (docs/01_SPEC.md §1, streams 1/2/3/5/6), which is not an override at
 * all — hence null, matching how `verify()` has always written the column.
 *
 * DOCUMENTED LIMITATION — `commissionRateOverride` is NOT the rate anything
 * actually charges. PurchaseService, ContentPieceService and
 * CreatorEarningsService each re-derive the rate from
 * `CreatorState.tier + CreatorState.subscriptionPaid`. Making this column
 * authoritative means editing those three services, which is outside this
 * change's scope, so this helper does the next best thing: it makes the
 * column derive from `tier` in ONE place, so every write in this service
 * (subscribe, upgrade, and now the scheduled-downgrade settlement) agrees
 * with the tier, and the column can no longer drift away from what the
 * other three services compute. See the final report.
 */
function commissionRateOverrideFor(tier: CreatorTier): number | null {
  return tier === 'basic' ? null : PRO_COMMISSION_RATE_OVERRIDE;
}

/**
 * The customer reference this service used to fabricate at subscribe time
 * (`flw-cust-<wawuUserId>`). Flutterwave never issued it, so it can never
 * resolve to a card — any subscription still carrying one has no usable
 * card on file and must not be charged against it. Recognised (not
 * charged) so past-due creators who subscribed before the fix get an
 * actionable error instead of a guaranteed decline.
 */
const FABRICATED_CUSTOMER_REF_PREFIX = 'flw-cust-';

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
  /**
   * Naira the server intended to charge. Verification must check the amount
   * Flutterwave actually took against this: `initCharge` does not call
   * Flutterwave, so the CLIENT supplies the amount to the inline SDK. Without
   * this check a caller could open checkout for ₦100 and still be granted
   * Pro. Every other paid module already enforces `amount >= expected`.
   */
  expectedAmount: number;
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
  /**
   * Charge attempts are persisted (PendingCharge), never held in memory.
   * A process-local Map lost the record on any deploy, crash or second
   * replica between the checkout popup and its callback — the customer was
   * charged at Flutterwave and this backend had nothing to reconcile.
   */
  private async recordPendingCharge(
    txRef: string,
    attempt: PendingAttempt & { expectedAmount: number },
  ): Promise<void> {
    await this.prisma.pendingCharge.create({
      data: {
        txRef,
        kind: attempt.kind,
        wawuUserId: attempt.wawuUserId,
        expectedAmount: attempt.expectedAmount,
        context: { tier: attempt.tier, planId: attempt.planId },
      },
    });
  }

  private async takePendingCharge(
    txRef: string,
    wawuUserId: string,
  ): Promise<(PendingAttempt & { expectedAmount: number }) | null> {
    const row = await this.prisma.pendingCharge.findUnique({
      where: { txRef },
    });
    if (!row || row.wawuUserId !== wawuUserId) return null;
    const ctx = (row.context ?? {}) as { tier?: CreatorTier; planId?: string };
    return {
      kind: row.kind as PendingAttemptKind,
      wawuUserId: row.wawuUserId,
      tier: ctx.tier ?? 'basic',
      planId: ctx.planId ?? '',
      expectedAmount: row.expectedAmount,
    };
  }

  constructor(
    private readonly prisma: PrismaService,
    @Inject(FLUTTERWAVE_CLIENT) private readonly flutterwave: FlutterwaveClient,
    private readonly notifications: NotificationService,
  ) {}

  /**
   * EVERY field is listed explicitly, deliberately — this used to spread the
   * Prisma row (`...row`). `CreatorSubscriptionResponse` is one of the 28
   * bare Prisma re-exports in the registry, so with a spread any column
   * added to this table silently widened a live app response. Enumerating
   * the projection means a new column is invisible on the wire until
   * somebody adds it here on purpose.
   *
   * `pendingTier` / `tierChangesAt` ARE added here on purpose: a downgrade
   * is a promise about the future, and the client cannot render "Pro until
   * 4 March, then Basic" from a row that only says "pro".
   */
  private toResponse(row: CreatorSubscriptionRow): CreatorSubscriptionResponse {
    return {
      creatorWawuId: row.creatorWawuId,
      tier: row.tier,
      status: row.status,
      commissionRateOverride: row.commissionRateOverride
        ? row.commissionRateOverride.toNumber()
        : null,
      flutterwaveCustomerRef: row.flutterwaveCustomerRef,
      flutterwavePlanId: row.flutterwavePlanId,
      currentPeriodEnd: row.currentPeriodEnd,
      renewalAttempts: row.renewalAttempts,
      cancelsAt: row.cancelsAt,
      cardLast4: row.cardLast4,
      pendingTier: row.pendingTier,
      tierChangesAt: row.tierChangesAt,
    };
  }

  /**
   * Apply a scheduled tier change once its moment has arrived, then return
   * the row as it now truly is.
   *
   * WHY A SCHEDULED CHANGE AT ALL: the subscription is annual and paid up
   * front, and neither downgrade nor cancel refunds anything (docs/01_SPEC.md
   * §4 — both tiers are "billed yearly"). Flipping a creator to Basic the
   * moment they tap Downgrade would take back the 90/10 split, the 15 upload
   * slots and private-community hosting they have already paid for through
   * the end of the term. So the change lands at `currentPeriodEnd`, and the
   * response says so.
   *
   * WHY HERE AND NOT IN A CRON: this settles on the next touch of the
   * subscription (any endpoint on this resource, including the renewal
   * retry, which is the only implemented path that starts a new paid term).
   * A `SchedulerService` sweep calling this on the hour would make it
   * eager rather than lazy; that is a one-line addition in src/scheduler/,
   * which is outside this change's scope — see the final report. It is a
   * latency improvement, not a correctness one: between period end and the
   * next touch the subscription is `past_due` anyway, which already strips
   * `CreatorState.subscriptionPaid` and with it every Pro benefit.
   *
   * `CreatorState.tier` is written in the same transaction because that —
   * not `CreatorSubscription.tier` — is the column the rest of the backend
   * reads: `uploadAllowanceFor(state.tier)` (slots), the three
   * `resolveCommissionRate()` copies (the split), `CommunityService.create`
   * (private communities) and `LearnEntitlementService` (free courses) all
   * key off it. Flipping it is what makes the downgrade real everywhere.
   */
  private async settleScheduledTierChange(
    row: CreatorSubscriptionRow,
  ): Promise<CreatorSubscriptionRow> {
    const pendingTier = row.pendingTier;
    if (
      !pendingTier ||
      !row.tierChangesAt ||
      row.tierChangesAt.getTime() > Date.now()
    ) {
      return row;
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.creatorSubscription.update({
        where: { creatorWawuId: row.creatorWawuId },
        data: {
          tier: pendingTier,
          commissionRateOverride: commissionRateOverrideFor(pendingTier),
          pendingTier: null,
          tierChangesAt: null,
        },
      });

      // OVER-CAP CREATORS: nothing is deleted, unpublished or hidden. A Pro
      // creator with 12 live pieces who drops to Basic (6 slots) keeps all
      // 12 published and earning; `CreatorState.slotsUsed` is left exactly
      // as it is. ContentPieceService.create already claims a slot with
      // `where: { slotsUsed: { lt: allowance.total } }`, so at 12 used
      // against a 6-slot allowance that claim simply matches no rows and the
      // upload is refused with "You have used all 6 upload slots on your
      // basic plan." They come back under the cap by deleting their own
      // content, or by upgrading again. Zeroing or truncating slotsUsed here
      // would either destroy content or hand out free slots.
      await tx.creatorState.updateMany({
        where: { wawuUserId: row.creatorWawuId },
        data: { tier: pendingTier },
      });

      return updated;
    });
  }

  /**
   * The single read path for this resource: fetch, apply any tier change
   * that has come due, 404 if the caller has never subscribed.
   */
  private async loadSubscription(
    creatorWawuId: string,
  ): Promise<CreatorSubscriptionRow> {
    const row = await this.prisma.creatorSubscription.findUnique({
      where: { creatorWawuId },
    });
    if (!row) {
      throw new NotFoundException(
        'No subscription yet — subscribe via POST /creator-subscription first.',
      );
    }
    return this.settleScheduledTierChange(row);
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
    return this.toResponse(await this.loadSubscription(creatorWawuId));
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

    await this.recordPendingCharge(charge.txRef, {
      kind: 'subscribe',
      wawuUserId,
      tier: dto.tier,
      planId: plan.planId,
      expectedAmount: charge.amount,
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
    const pending = await this.takePendingCharge(dto.tx_ref, wawuUserId);
    if (!pending) {
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
      result.txRef === dto.tx_ref &&
      result.amount >= pending.expectedAmount;

    // The delete IS the claim. Since the Flutterwave webhook landed, this
    // method has two callers that can arrive for the same tx_ref at the same
    // moment (the browser's /verify and PaymentWebhookService), and both will
    // have read the same pending row above. The row count below is the single
    // right to settle. Behaviour is otherwise unchanged: the charge is still
    // consumed whether or not it verified.
    const claim = await this.prisma.pendingCharge.deleteMany({
      where: { txRef: dto.tx_ref },
    });

    if (!verified) {
      throw new BadRequestException('Payment verification failed');
    }

    if (claim.count === 0) {
      // Lost the race — the other caller already granted this subscription.
      // Return what they wrote rather than granting a second one.
      return this.getSubscription(wawuUserId);
    }

    const now = new Date();

    if (pending.kind === 'subscribe') {
      // Subscription row, entitlement gate and account type are written in ONE
      // transaction. They are three faces of a single fact — "this person has
      // paid to be a creator" — and a partial write is a broken account: a
      // CreatorSubscription with no `accountType: 'creator'` leaves the payer
      // 403'd by every CreatorAccountGuard in the codebase (creator-earnings,
      // creator-subscription, content-piece, direct-message,
      // creator-no-response-tracker), which is exactly the production bug this
      // replaces.
      const row = await this.prisma.$transaction(async (tx) => {
        const subscription = await tx.creatorSubscription.upsert({
          where: { creatorWawuId: wawuUserId },
          create: {
            creatorWawuId: wawuUserId,
            tier: pending.tier,
            status: 'active',
            commissionRateOverride: commissionRateOverrideFor(pending.tier),
            // Flutterwave's own reusable card token, not a string this
            // backend invented. `flw-cust-${wawuUserId}` used to go here and
            // was the only thing retry-payment had to charge — see
            // retryPayment()'s doc comment. Null when the charge produced no
            // token (non-card method); retry-payment refuses rather than
            // charging a reference that cannot resolve.
            flutterwaveCustomerRef: result.cardToken ?? null,
            flutterwavePlanId: pending.planId,
            currentPeriodEnd: new Date(now.getTime() + ONE_YEAR_MS),
            renewalAttempts: 0,
            cancelsAt: null,
            cardLast4: result.cardLast4 ?? null,
            pendingTier: null,
            tierChangesAt: null,
          },
          update: {
            tier: pending.tier,
            status: 'active',
            commissionRateOverride: commissionRateOverrideFor(pending.tier),
            flutterwaveCustomerRef: result.cardToken ?? undefined,
            flutterwavePlanId: pending.planId,
            currentPeriodEnd: new Date(now.getTime() + ONE_YEAR_MS),
            renewalAttempts: 0,
            cancelsAt: null,
            cardLast4: result.cardLast4 ?? undefined,
            // A freshly paid term supersedes anything that was scheduled
            // against the term it replaces.
            pendingTier: null,
            tierChangesAt: null,
          },
        });

        // This is the ONLY code path allowed to set
        // CreatorState.subscriptionPaid = true (task brief — no other
        // dev-only toggle exists in this resource). CreatorState may not
        // exist yet for a first-time subscriber (creating it here, not in
        // UserProfile/CreatorState's own resources, mirrors how
        // CreditPurchase.verifyPurchase is the write-path originator for
        // CreditsState).
        await tx.creatorState.upsert({
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

        // Promote the account. Paying for a creator subscription IS choosing
        // a creator account — CreatorAccountGuard reads UserProfile
        // .accountType and nothing else, so without this the payer is locked
        // out of Earnings, Subscription management, uploads and paid DMs
        // despite a successful charge. A first-time subscriber may have no
        // UserProfile row at all (it is created on the first PATCH
        // /users/me, which onboarding may not have reached), so this upserts
        // with the model's own minimums: `accountType` is required and
        // `interests` is a String[]; every other column is nullable and is
        // deliberately left for the profile screen to fill in. Only ever
        // written UP to 'creator' — nothing here or anywhere else in this
        // service demotes (see cancel()/downgrade()/retryPayment()).
        await tx.userProfile.upsert({
          where: { wawuUserId },
          create: {
            wawuUserId,
            accountType: AccountType.creator,
            interests: [],
          },
          update: { accountType: AccountType.creator },
        });

        return subscription;
      });

      return this.toResponse(row);
    }

    // pending.kind === 'upgrade'
    //
    // The tier comes off the PENDING CHARGE, not a constant. Hardcoding 'pro'
    // here would have taken a Pro Max payment and granted Pro — the client
    // charged ₦29,999 for the tier below the one they bought.
    const upgradeTo = pending.tier;
    const row = await this.prisma.creatorSubscription.update({
      where: { creatorWawuId: wawuUserId },
      data: {
        tier: upgradeTo,
        status: 'active',
        commissionRateOverride: commissionRateOverrideFor(upgradeTo),
        flutterwavePlanId: pending.planId,
        flutterwaveCustomerRef: result.cardToken ?? undefined,
        cardLast4: result.cardLast4 ?? undefined,
        // Paying to be Pro cancels a downgrade that was scheduled against
        // the old term.
        pendingTier: null,
        tierChangesAt: null,
        // currentPeriodEnd is deliberately untouched — upgrading keeps the
        // existing annual anniversary; only the price paid today (prorated)
        // and future renewal amount change. See upgrade()'s doc comment.
      },
    });

    await this.prisma.creatorState.update({
      where: { wawuUserId },
      data: { tier: upgradeTo },
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
  async upgrade(
    creatorWawuId: string,
    to: CreatorTier = 'pro',
  ): Promise<FlutterwaveConfigResponse> {
    const existing = await this.loadSubscription(creatorWawuId);
    // Rank rather than string equality, so Basic -> Pro, Basic -> Pro Max and
    // Pro -> Pro Max all work through one path. Comparing against 'pro' meant
    // a Pro subscriber could never reach Pro Max: the guard read "already
    // Pro" and refused.
    if (to === 'basic') {
      throw new BadRequestException('Basic is not an upgrade. Use downgrade.');
    }
    if (tierRank(existing.tier) >= tierRank(to)) {
      throw new BadRequestException(
        `This subscription is already ${existing.tier === 'pro_max' ? 'Pro Max' : 'Pro'}.`,
      );
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
    // Credit against what they are ACTUALLY on, not against Basic. A Pro
    // subscriber moving to Pro Max has paid ₦14,999, and crediting them
    // ₦5,999 of it would quietly charge them for a year they already own.
    const credit = Math.round(
      (daysRemaining / 365) * PRICE_TABLE[existing.tier],
    );
    const dueToday = Math.max(PRICE_TABLE[to] - credit, 1);

    const plan = await this.flutterwave.createOrReusePlan({
      tier: to,
      amount: PRICE_TABLE[to],
    });
    const charge = this.flutterwave.initCharge({
      amount: dueToday,
      purpose: `upgrade-${to}`,
      wawuUserId: creatorWawuId,
      planId: plan.planId,
    });

    await this.recordPendingCharge(charge.txRef, {
      kind: 'upgrade',
      wawuUserId: creatorWawuId,
      tier: to,
      planId: plan.planId,
      expectedAmount: charge.amount,
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
   * POST /creator-subscription/downgrade — Pro -> Basic, scheduled for
   * `currentPeriodEnd`.
   *
   * WHEN IT TAKES EFFECT, AND WHY THEN. The subscription is annual and paid
   * in full up front (docs/01_SPEC.md §4: "Both tiers are billed yearly"),
   * and nothing here refunds the unused part of a Pro year. Applying Basic
   * the instant the button is tapped would therefore confiscate paid-for
   * entitlements — the 90/10 split (§1 stream 8, §4: "90/10 revenue split on
   * streams 1, 2, 3, 5, 6 ... this is the actual value prop of paying for
   * Pro"), 15 upload slots vs Basic's 6 (§4), and private-community hosting
   * (§4) — while keeping the ₦18,999. So the request records the intent and
   * the tier flips at `currentPeriodEnd`. Symmetrically, no Basic-rate
   * credit is paid out now either: "no refund" cuts both ways.
   *
   * The API says so rather than implying it: the response carries
   * `pendingTier: "basic"` and `tierChangesAt: <currentPeriodEnd>`, so the
   * client can render the exact date the split changes instead of the app's
   * previous unqualified "goes from 90% back to 85%".
   *
   * WHAT HAPPENS TO A CREATOR OVER THE BASIC CAP: nothing is deleted,
   * unpublished or hidden. See settleScheduledTierChange().
   *
   * Idempotent: downgrading twice re-returns the same scheduled row.
   *
   * Account type is untouched (see cancel()'s note): a Pro -> Basic move is
   * a tier change, and both tiers are creator accounts regardless.
   */
  async downgrade(creatorWawuId: string): Promise<CreatorSubscriptionResponse> {
    const existing = await this.loadSubscription(creatorWawuId);
    if (existing.tier === 'basic') {
      throw new BadRequestException('This subscription is already Basic.');
    }
    if (existing.status !== 'active') {
      throw new BadRequestException(
        'Only an active subscription can be downgraded.',
      );
    }
    if (existing.pendingTier === 'basic') {
      return this.toResponse(existing);
    }

    const row = await this.prisma.creatorSubscription.update({
      where: { creatorWawuId },
      data: {
        pendingTier: 'basic',
        // Never `now` — the paid term runs to currentPeriodEnd.
        tierChangesAt: existing.currentPeriodEnd,
      },
    });
    return this.toResponse(row);
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
   *
   * On the exhausted-retries path the subscription lapses to `expired` and
   * the hourly scheduler clears `CreatorState.subscriptionPaid`. Account
   * type is deliberately NOT demoted (see cancel()'s note) — a declined card
   * closes the upload gate, it does not turn a creator back into a viewer.
   *
   * THE REFERENCE IT CHARGES IS NOW A REAL ONE. `flutterwaveCustomerRef`
   * used to be written at subscribe time as `flw-cust-<wawuUserId>` — a
   * string this backend made up. Flutterwave's tokenized-charge API only
   * accepts a token it issued itself (`data.card.token` on the verify
   * response), so that value could never resolve to a card and this recovery
   * path could not succeed in production for anybody. verify() now persists
   * the real token, PATCH /card persists one the client supplies, and this
   * method refuses to fire a charge against a fabricated or missing one.
   */
  async retryPayment(
    creatorWawuId: string,
    cardholderEmail: string | null,
  ): Promise<FlutterwaveConfigResponse> {
    const existing = await this.loadSubscription(creatorWawuId);
    if (existing.status !== 'past_due') {
      throw new BadRequestException(
        'This subscription is not currently past due.',
      );
    }

    // A retry can only work against a token Flutterwave itself issued. If
    // all this row has is the old locally-fabricated `flw-cust-<id>` string
    // (or nothing at all), firing the charge is a guaranteed decline that
    // would also burn one of the three renewal attempts and push the
    // creator toward `expired`. Refuse with the actual remedy instead.
    const savedCardToken = existing.flutterwaveCustomerRef;
    if (
      !savedCardToken ||
      savedCardToken.startsWith(FABRICATED_CUSTOMER_REF_PREFIX)
    ) {
      throw new BadRequestException(
        'There is no usable saved card on this subscription. Add your card with PATCH /creator-subscription/card, then retry the payment.',
      );
    }

    // `existing` has already been through settleScheduledTierChange(), so a
    // creator who scheduled a downgrade and whose term has now ended renews
    // onto BASIC at ₦5,999 — not onto Pro at ₦18,999. Charging the old tier
    // here would have quietly resold the tier they cancelled.
    const amount = PRICE_TABLE[existing.tier];
    const result = await this.flutterwave.chargeSavedCard({
      flutterwaveCustomerRef: savedCardToken,
      email: cardholderEmail,
      amount,
      purpose: 'retry-payment',
    });

    if (result.status === 'successful') {
      const renewedUntil = new Date(Date.now() + ONE_YEAR_MS);
      await this.prisma.$transaction(async (tx) => {
        await tx.creatorSubscription.update({
          where: { creatorWawuId },
          data: {
            status: 'active',
            currentPeriodEnd: renewedUntil,
            renewalAttempts: 0,
          },
        });
        // SchedulerService cleared this when the subscription went past_due.
        // A successful renewal has to hand the upload gate back, or the
        // creator pays and stays locked out.
        await tx.creatorState.updateMany({
          where: { wawuUserId: creatorWawuId },
          data: { subscriptionPaid: true, tier: existing.tier },
        });
      });

      // Renewal confirmed — emitted after the transaction commits, and only
      // on the successful branch. The decline path below throws instead, and
      // the creator hears about that from SchedulerService's past_due sweep.
      await this.notifications.emit({
        kind: 'subscription_renewal',
        userWawuId: creatorWawuId,
        state: 'renewed',
        tier: existing.tier,
        amount,
        nextRenewalAt: renewedUntil,
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
   *
   * `SubscriptionStatus.cancelled` IS REACHABLE — this method is what
   * produces it. It previously wrote only `cancelsAt`, so nothing in the
   * codebase could ever set `cancelled` and the guard below that reads it
   * was dead. The split is by whether there is any paid term left to honour:
   *
   *   - Term still running (`active`, `currentPeriodEnd` in the future):
   *     stays `active`, `cancelsAt = currentPeriodEnd`. The creator keeps
   *     what they paid for. SchedulerService closes it out at that date.
   *   - Nothing left to honour (`past_due`, or the period has already
   *     ended): there is no entitlement to run down, so the cancellation is
   *     immediate and the status becomes `cancelled` in the same write.
   *     `CreatorState.subscriptionPaid` is cleared here too, because
   *     SchedulerService's own cleanup sweep only looks at `past_due` and
   *     `expired` rows — a `cancelled` row would otherwise keep handing out
   *     the upload gate forever.
   *
   * `cancelled` and `expired` stay distinct and both mean something:
   * `cancelled` is "the creator ended this", `expired` is "it lapsed on
   * non-payment". Any scheduled downgrade is dropped — there is no longer a
   * later term for it to apply to.
   *
   * ACCOUNT TYPE IS NOT TOUCHED, HERE OR ANYWHERE ELSE. Cancelling ends the
   * paid entitlement, not the identity: per CLAUDE.md, creator is an ACCOUNT
   * TYPE, not an earned tier or a trust level. Flipping
   * `UserProfile.accountType` back to 'user' would delete someone's account
   * identity — their handle, their creator profile, their whole
   * Create-vs-Explore navigation — because a card expired. The gate that
   * SHOULD close is `CreatorState.subscriptionPaid` (uploading), and the
   * scheduler already closes it. Nothing in this service, and nothing in
   * src/scheduler/scheduler.service.ts, writes accountType at all.
   */
  async cancel(creatorWawuId: string): Promise<CreatorSubscriptionResponse> {
    const existing = await this.loadSubscription(creatorWawuId);
    if (existing.status === 'cancelled' || existing.status === 'expired') {
      throw new BadRequestException('This subscription is not active.');
    }

    const nothingLeftToHonour =
      existing.status === 'past_due' ||
      existing.currentPeriodEnd.getTime() <= Date.now();

    if (nothingLeftToHonour) {
      const row = await this.prisma.$transaction(async (tx) => {
        const cancelled = await tx.creatorSubscription.update({
          where: { creatorWawuId },
          data: {
            status: 'cancelled',
            cancelsAt: existing.cancelsAt ?? new Date(),
            pendingTier: null,
            tierChangesAt: null,
          },
        });
        await tx.creatorState.updateMany({
          where: { wawuUserId: creatorWawuId },
          data: { subscriptionPaid: false },
        });
        return cancelled;
      });
      return this.toResponse(row);
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
    // Still 404s for a creator who has never subscribed (and settles any
    // tier change that has come due while we are here).
    await this.loadSubscription(creatorWawuId);

    const last4 = dto.flutterwaveCardToken.slice(-4);
    await this.prisma.creatorSubscription.update({
      where: { creatorWawuId },
      data: {
        cardLast4: last4,
        // The token IS the thing a later tokenized charge is fired against,
        // so it is now persisted instead of being read for its last 4
        // characters and thrown away. This is the supported way for a
        // past-due creator whose row still carries the old fabricated
        // `flw-cust-<id>` reference to get a chargeable card on file.
        flutterwaveCustomerRef: dto.flutterwaveCardToken,
      },
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
