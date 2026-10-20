import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { FeeQuoteService } from '../../money/fees/fee-quote.service';
import type { LedgerMovementInput } from '../../money/ledger/ledger.interface';
import { koboNumber, LedgerService } from '../../money/ledger/ledger.service';
import { PaymentSettings } from '../../money/payments/payment-config';
import { NotificationService } from '../../notification/notification.service';
import { isRowOf } from '../../wallet-provider/provider-rows';
import {
  type ProviderReconciliation,
  type ProviderTransferReceipt,
  safeKoboNumber,
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import { WalletProviderError } from '../../wallet-provider/wallet-provider-error';
import { WalletProviderLimitError } from '../../wallet-provider/wallet-provider-limit';
import {
  PASS_REFUND_NARRATION,
  passRefundReference,
  passTitle,
} from './community-pass-rules';
import { CommunityPassRemoval } from './community-pass-removal.service';

type RefundRow = Prisma.CommunityPassRefundGetPayload<object>;

const MINUTE = 60_000;
const SWEEP_PAGE = 50;
/** One pass of the sweep stops reading when this much time is used. */
const SWEEP_BUDGET_MS = 45_000;

/** Why nothing has moved yet. `member_wallet`: the member has no wallet (R-11). */
export type PassRefundWaiting =
  'member_wallet' | 'recipient_frozen' | 'funds' | 'provider' | 'refused';

export type PassRefundState = 'refunded' | 'pending' | 'waiting' | 'review';

export interface PassRefundResult {
  refundId: string;
  state: PassRefundState;
  waiting: PassRefundWaiting | null;
}

/** The rest before the next try or question: 1, 2, 4 ... minutes, at most an hour. */
function restMs(count: number): number {
  return Math.min(60, 2 ** Math.min(Math.max(count, 0), 6)) * MINUTE;
}

/** A member with no wallet rests a minute to an hour by the refund's age, and is woken when the wallet exists. */
function walletWaitRestMs(ageMs: number): number {
  const age = Number.isFinite(ageMs) ? Math.max(0, ageMs) : 0;
  return Math.min(60 * MINUTE, Math.max(MINUTE, age));
}

/**
 * Pays a removed member's unused pass days back (task INBOX-25, owner ruling
 * Q-43, R-71). WAWU pays at once from its merchant account to the member's
 * wallet through the provider seam (R-19, R-39): the member caused nothing.
 * This is the hold's refund (MONEY-18) for a sum the hold cannot express:
 *
 * - **One reference.** `wawu-pref-<refund id>`; the provider refuses a repeat.
 *   The move is handed over under a lease (`sentAt`) only one caller wins, so
 *   the request, the sweep and a second server never send it twice.
 * - **The provider's record is the truth.** The refund is `refunded` only when
 *   the provider confirmed it, from its answer or from its record of our
 *   reference when the answer was lost. A move whose outcome is unknown (a
 *   timeout, a 5xx, accepted and not finished, a repeated reference) is asked
 *   about, backing off to hourly, and never sent again; past
 *   PAYMENT_REVIEW_AFTER_HOURS it goes to a person. Only the provider's own
 *   record that the move FAILED starts a new try, under a new reference, one
 *   per confirmed failure and never two in flight.
 * - **Waiting is not failing.** A member with no wallet keeps the refund
 *   waiting in WAWU's account and is paid within a minute of opening one
 *   (R-11); a frozen wallet, a provider out of reach, or WAWU's account short
 *   of money wait and are tried again.
 * - **One wallet row, one notification.** Both sides of the move go to the
 *   ledger under our reference (the member's `in` row is the wallet row), and
 *   the member is told once, when the provider has confirmed it.
 *
 * A server acts only on refunds of the provider it runs (R-39). The host's
 * 85% of these days is not touched here: see `EarningDeduction`.
 */
@Injectable()
export class CommunityPassRefundService implements OnModuleInit {
  private readonly logger = new Logger(CommunityPassRefundService.name);
  private sweeping = false;
  private sweepAfter: { at: Date; id: string } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(WALLET_PROVIDER) private readonly provider: WalletProvider,
    private readonly ledger: LedgerService,
    private readonly fees: FeeQuoteService,
    private readonly settings: PaymentSettings,
    private readonly notifications: NotificationService,
    private readonly removal: CommunityPassRemoval,
  ) {}

  onModuleInit(): void {
    // A refund is paid at once: the removal tells this service the moment it
    // is written. If this misses, the sweep pays it within the minute.
    this.removal.onDecided((id) => {
      void this.drive(id).catch((e: unknown) => {
        this.logger.error(
          `refund ${id}: could not be driven at once (${e instanceof Error ? e.name : 'error'}); the sweep pays it`,
        );
      });
    });
  }

  /** What is owed to removed members and not yet confirmed, for the nightly check. */
  async pendingTotals(): Promise<{ count: number; amountKobo: bigint }> {
    const rows = await this.prisma.communityPassRefund.aggregate({
      where: { status: 'pending', provider: this.provider.name },
      _count: { _all: true },
      _sum: { amountKobo: true },
    });
    return {
      count: rows._count._all,
      amountKobo: rows._sum.amountKobo ?? 0n,
    };
  }

  // -------------------------------------------------------------------------
  // The sweep
  // -------------------------------------------------------------------------

  /** Every minute: each pending refund that is due, of the provider this server runs. */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'community-pass-refund-settle' })
  async sweep(
    now = new Date(),
    opts: { budgetMs?: number } = {},
  ): Promise<{ checked: number; settled: number }> {
    const counts = { checked: 0, settled: 0 };
    if (this.sweeping) return counts;
    this.sweeping = true;
    const budgetMs = opts.budgetMs ?? SWEEP_BUDGET_MS;
    const started = Date.now();
    try {
      await this.wakeWalletWaiters(now);
      let after = this.sweepAfter;
      for (;;) {
        const due = await this.prisma.communityPassRefund.findMany({
          where: {
            status: 'pending',
            reviewSince: null,
            provider: this.provider.name,
            OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
            ...(after
              ? {
                  AND: [
                    {
                      OR: [
                        { createdAt: { gt: after.at } },
                        { createdAt: after.at, id: { gt: after.id } },
                      ],
                    },
                  ],
                }
              : {}),
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: SWEEP_PAGE,
          select: { id: true, createdAt: true },
        });
        for (const { id, createdAt } of due) {
          counts.checked += 1;
          try {
            const r = await this.drive(id, now);
            if (r.state === 'refunded') counts.settled += 1;
          } catch (e) {
            this.logger.error(
              `refund ${id}: the sweep could not drive it (${e instanceof Error ? e.name : 'error'})`,
            );
          }
          if (Date.now() - started >= budgetMs) {
            this.sweepAfter = { at: createdAt, id };
            return counts;
          }
        }
        if (due.length < SWEEP_PAGE) {
          this.sweepAfter = null;
          break;
        }
        const last = due[due.length - 1];
        after = { at: last.createdAt, id: last.id };
      }
    } catch (e) {
      this.logger.error(
        `pass refund sweep failed: ${e instanceof Error ? e.message : 'unknown'}`,
      );
    } finally {
      this.sweeping = false;
    }
    return counts;
  }

  /** A refund waiting for a member's wallet is made due the moment the wallet exists (R-11). */
  private async wakeWalletWaiters(now: Date): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        UPDATE "CommunityPassRefund" r
           SET "nextAttemptAt" = NULL
         WHERE r."status" = 'pending' AND r."reviewSince" IS NULL
           AND r."sentAt" IS NULL AND r."provider" = ${this.provider.name}
           AND r."waiting" = 'member_wallet' AND r."nextAttemptAt" > ${now}
           AND EXISTS (
             SELECT 1 FROM "FintavaWallet" w
              WHERE w."wawuUserId" = r."userWawuId"
                AND LOWER(BTRIM(COALESCE(w."provider", 'fintava'))) = ${this.provider.name})`;
    } catch (e) {
      this.logger.error(
        `pass refund sweep: could not wake the refunds waiting for a wallet (${e instanceof Error ? e.name : 'error'})`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // One step
  // -------------------------------------------------------------------------

  /** Moves a refund one step: asks the provider about a move that was handed over, or hands it over. */
  async drive(refundId: string, now = new Date()): Promise<PassRefundResult> {
    const r = await this.load(refundId);
    if (r.status !== 'pending' || r.reviewSince) return this.resultOf(r);
    if (r.nextAttemptAt && r.nextAttemptAt.getTime() > now.getTime()) {
      return this.resultOf(r);
    }
    if (!isRowOf(this.provider.name, r.provider)) {
      // Another provider holds this money: this one sends nothing for it.
      return this.waitFor(r, 'provider', now, true);
    }
    return r.sentAt ? this.reconcile(r, now) : this.send(r, now);
  }

  private async send(r: RefundRow, now: Date): Promise<PassRefundResult> {
    const cap = this.fees.providerFees.merchantMaxPerTxnKobo;
    if (cap !== null && r.amountKobo > BigInt(cap)) {
      return this.toReview(
        r,
        `the refund of ${r.amountKobo} kobo is above the cap of ${cap} kobo on one move through WAWU's account`,
      );
    }
    const wallet = await this.prisma.fintavaWallet.findUnique({
      where: { wawuUserId: r.userWawuId },
      select: { accountNumber: true, provider: true },
    });
    if (!wallet || !isRowOf(this.provider.name, wallet.provider)) {
      return this.waitFor(r, 'member_wallet', now);
    }
    if (
      await this.isWawuAccount(r.merchantAccountNumber, wallet.accountNumber)
    ) {
      return this.toReview(
        r,
        "the refund would move money from WAWU's account to WAWU's account",
      );
    }

    // The lease: only the caller that wins it hands the move to the provider.
    const leaseUntil = new Date(
      now.getTime() +
        this.provider.timings.moneyTimeoutMs +
        this.provider.timings.resendSafetyMs,
    );
    const leased = await this.prisma.communityPassRefund.updateMany({
      where: {
        id: r.id,
        status: 'pending',
        reviewSince: null,
        sentAt: null,
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      data: {
        sentAt: now,
        nextAttemptAt: leaseUntil,
        attempts: { increment: 1 },
        waiting: null,
        destinationAccountNumber: wallet.accountNumber,
      },
    });
    if (leased.count === 0) return this.resultOf(await this.load(r.id));

    let receipt: ProviderTransferReceipt;
    try {
      receipt = await this.provider.walletToWallet({
        fromAccountNumber: r.merchantAccountNumber,
        toAccountNumber: wallet.accountNumber,
        amountKobo: r.amountKobo,
        reference: r.customerReference,
        narration: PASS_REFUND_NARRATION,
      });
    } catch (e) {
      return this.afterRefusal(r, e, now);
    }
    return this.afterReceipt(
      { ...r, destinationAccountNumber: wallet.accountNumber },
      receipt,
    );
  }

  private async isWawuAccount(
    merchant: string,
    destination: string,
  ): Promise<boolean> {
    if (merchant === destination) return true;
    if (!this.provider.isSameAccount) return false;
    try {
      return await this.provider.isSameAccount(destination, merchant);
    } catch {
      return false;
    }
  }

  /** The provider did not take the move, or we do not know whether it did. */
  private async afterRefusal(
    r: RefundRow,
    e: unknown,
    now: Date,
  ): Promise<PassRefundResult> {
    const refusal = e instanceof WalletProviderError ? e : null;
    if (refusal?.providerFailed) {
      // The provider TOOK the move and its own record says it failed: read the
      // record (a read, nothing is sent); it starts the new try.
      return this.reconcile(r, now);
    }
    if (!refusal || (refusal.recordMayExist && !refusal.requestNotSent)) {
      // Money may have moved: asked about, never sent again.
      this.logger.warn(
        `refund ${r.id}: the outcome is unknown (${refusal?.kind ?? 'error'}); asking ${this.provider.label} about it`,
      );
      await this.schedule(r, now, 1);
      return this.resultOf(await this.load(r.id));
    }
    let waiting: PassRefundWaiting;
    if (refusal.requestNotSent || refusal instanceof WalletProviderLimitError) {
      waiting = 'provider';
    } else if (refusal.kind === 'insufficient_funds') waiting = 'funds';
    else if (refusal.kind === 'wallet_inactive') waiting = 'recipient_frozen';
    else if (
      [
        'auth',
        'not_configured',
        'merchant_inactive',
        'rate_limited',
        'unavailable',
        'not_supported',
        'bad_response',
      ].includes(refusal.kind)
    ) {
      waiting = 'provider';
    } else {
      waiting = 'refused';
    }
    if (waiting === 'funds') {
      this.logger.error(
        `refund ${r.id}: ${this.provider.label} says WAWU's own account cannot cover the refund (${r.amountKobo} kobo)`,
      );
    } else if (waiting === 'refused') {
      this.logger.error(
        `refund ${r.id}: ${this.provider.label} refused the refund (${refusal.kind}); nothing moved`,
      );
    }
    // Nothing moved: the lease is given back and the same reference is used again.
    await this.prisma.communityPassRefund.updateMany({
      where: { id: r.id, status: 'pending', sentAt: { not: null } },
      data: {
        sentAt: null,
        waiting,
        nextAttemptAt: new Date(now.getTime() + restMs(r.attempts + 1)),
      },
    });
    if (waiting === 'refused' && this.refusedTooLong(r, now)) {
      return this.toReview(
        r,
        `the refund has been refused for ${this.settings.reviewAfterHours} hours`,
      );
    }
    return this.resultOf(await this.load(r.id));
  }

  private refusedTooLong(r: RefundRow, now: Date): boolean {
    return (
      now.getTime() - r.createdAt.getTime() >=
      this.settings.reviewAfterHours * 3_600_000
    );
  }

  /** The provider confirmed the move in its answer. */
  private async afterReceipt(
    r: RefundRow,
    receipt: ProviderTransferReceipt,
  ): Promise<PassRefundResult> {
    if (receipt.amountKobo !== r.amountKobo) {
      return this.toReview(
        r,
        `${this.provider.label} moved ${receipt.amountKobo} kobo for a refund of ${r.amountKobo} kobo`,
      );
    }
    return this.settle(r, {
      feeKobo: receipt.feeKobo,
      refs: {
        fintavaReference: receipt.providerReference,
        tagapayTransRef: receipt.secondaryReference,
        fintavaTransactionId: receipt.transactionId,
      },
      occurredAt: null,
    });
  }

  // -------------------------------------------------------------------------
  // Asking the provider about a move that was handed over
  // -------------------------------------------------------------------------

  private async reconcile(r: RefundRow, now: Date): Promise<PassRefundResult> {
    let answer: ProviderReconciliation | null = null;
    try {
      answer = await this.provider.reconcileSend(
        r.customerReference,
        { kind: 'merchant' },
        r.sentAt ?? r.createdAt,
      );
    } catch (e) {
      this.logger.warn(
        `refund ${r.id}: ${this.provider.label} could not be asked (${e instanceof WalletProviderError ? e.kind : 'error'})`,
      );
    }
    if (answer?.state === 'found') {
      const t = answer.transaction;
      if (t.outcome === 'completed') {
        if (t.amountKobo !== r.amountKobo) {
          return this.toReview(
            r,
            `${this.provider.label} moved ${t.amountKobo} kobo for a refund of ${r.amountKobo} kobo`,
          );
        }
        const tagapay =
          t.secondaryReference ??
          (await this.provider.secondaryReferenceOf(t).catch(() => null));
        return this.settle(r, {
          feeKobo: t.feeKobo ?? null,
          refs: {
            fintavaReference: t.providerReference,
            tagapayTransRef: tagapay,
            fintavaTransactionId: t.id,
          },
          occurredAt: Number.isNaN(Date.parse(t.createdAt))
            ? null
            : new Date(t.createdAt),
        });
      }
      if (t.outcome === 'failed') {
        // The provider's own record: the money is where it was. Only this
        // starts a new try, under a new reference.
        return this.retryAfterFailure(r, now);
      }
      if (t.outcome === 'reversed') {
        return this.toReview(
          r,
          `${this.provider.label} moved the refund and then reversed it; WAWU's account holds the money again`,
        );
      }
      // Pending, or a word we do not know: neither says no money moved.
    }
    return this.stillUnknown(r, now);
  }

  private async stillUnknown(
    r: RefundRow,
    now: Date,
  ): Promise<PassRefundResult> {
    const since = (r.sentAt ?? r.createdAt).getTime();
    if (now.getTime() - since >= this.settings.reviewAfterHours * 3_600_000) {
      return this.toReview(
        r,
        `no answer from ${this.provider.label} about the refund after ${this.settings.reviewAfterHours} hours; it may have moved`,
      );
    }
    await this.schedule(r, now, r.checks + 1);
    return this.resultOf(await this.load(r.id));
  }

  private async schedule(
    r: RefundRow,
    now: Date,
    checks: number,
  ): Promise<void> {
    await this.prisma.communityPassRefund.updateMany({
      where: { id: r.id, status: 'pending' },
      data: {
        checks: { increment: 1 },
        nextAttemptAt: new Date(now.getTime() + restMs(checks)),
      },
    });
  }

  /** The provider's record says the move failed: one new try, under a new reference. */
  private async retryAfterFailure(
    r: RefundRow,
    now: Date,
  ): Promise<PassRefundResult> {
    const attempt = r.attempt + 1;
    this.logger.warn(
      `refund ${r.id}: ${this.provider.label} says the refund failed; trying again as attempt ${attempt}`,
    );
    await this.prisma.communityPassRefund.updateMany({
      where: {
        id: r.id,
        status: 'pending',
        sentAt: { not: null },
        customerReference: r.customerReference,
      },
      data: {
        attempt,
        customerReference: passRefundReference(r.id, attempt),
        sentAt: null,
        checks: 0,
        waiting: 'refused',
        nextAttemptAt: new Date(now.getTime() + restMs(attempt)),
      },
    });
    const fresh = await this.load(r.id);
    if (
      fresh.status === 'pending' &&
      !fresh.reviewSince &&
      !fresh.sentAt &&
      this.refusedTooLong(fresh, now)
    ) {
      return this.toReview(
        fresh,
        `the refund has failed at ${this.provider.label} for ${this.settings.reviewAfterHours} hours`,
      );
    }
    return this.resultOf(fresh);
  }

  // -------------------------------------------------------------------------
  // Settling
  // -------------------------------------------------------------------------

  /** The provider confirmed: both sides go to the ledger, the refund is over, the member is told once. */
  private async settle(
    r: RefundRow,
    fig: {
      feeKobo: bigint | null;
      refs: {
        fintavaReference?: string | null;
        tagapayTransRef?: string | null;
        fintavaTransactionId?: string | null;
      };
      occurredAt: Date | null;
    },
  ): Promise<PassRefundResult> {
    const fee = fig.feeKobo !== null && fig.feeKobo >= 0n ? fig.feeKobo : null;
    await this.writeLedger(r, fee, fig.refs, fig.occurredAt);
    const { count } = await this.prisma.communityPassRefund.updateMany({
      where: { id: r.id, status: 'pending' },
      data: {
        status: 'refunded',
        settledAt: new Date(),
        providerFeeKobo: fee,
        waiting: null,
        nextAttemptAt: null,
      },
    });
    if (count > 0) await this.tellMember(r);
    return this.resultOf(await this.load(r.id));
  }

  /** One notification per refund: the claim is one conditional write. */
  private async tellMember(r: RefundRow): Promise<void> {
    try {
      const claimed = await this.prisma.communityPassRefund.updateMany({
        where: { id: r.id, notifiedAt: null },
        data: { notifiedAt: new Date() },
      });
      if (claimed.count !== 1) return;
      const community = await this.prisma.community.findUnique({
        where: { id: r.communityId },
        select: { name: true },
      });
      await this.notifications.emit({
        kind: 'community_pass_refunded',
        userWawuId: r.userWawuId,
        communityId: r.communityId,
        communityName: community?.name ?? 'the room',
        amount: Number(r.amountKobo) / 100,
      });
    } catch (e) {
      this.logger.error(
        `refund ${r.id}: the member could not be told (${e instanceof Error ? e.name : 'error'})`,
      );
    }
  }

  /**
   * Both sides of the move in the ledger under our reference: WAWU's account
   * (money out) and the member's wallet (money in, the wallet row). Best
   * effort, like every ledger write after the money moved.
   */
  private async writeLedger(
    r: RefundRow,
    fee: bigint | null,
    refs: {
      fintavaReference?: string | null;
      tagapayTransRef?: string | null;
      fintavaTransactionId?: string | null;
    },
    occurredAt: Date | null,
  ): Promise<void> {
    const dest = r.destinationAccountNumber;
    if (!dest) return;
    const community = await this.prisma.community
      .findUnique({ where: { id: r.communityId }, select: { name: true } })
      .catch(() => null);
    const amount = koboNumber(r.amountKobo);
    const common = {
      status: 'completed' as const,
      category: 'refund' as const,
      link: {
        kind: 'community_pass' as const,
        targetId: r.communityId,
        title: community ? passTitle(community.name) : 'Room pass',
      },
      narration: PASS_REFUND_NARRATION,
      references: { customerReference: r.customerReference, ...refs },
      source: 'send' as const,
      ...(occurredAt ? { occurredAt } : {}),
    };
    const takenFee = fee ?? this.expectedFeeKobo(r.amountKobo) ?? 0n;
    const out: LedgerMovementInput = {
      ...common,
      wallet: { kind: 'merchant', accountNumber: r.merchantAccountNumber },
      direction: 'out',
      amountKobo: amount,
      feeKobo: koboNumber(takenFee),
      totalKobo: amount + koboNumber(takenFee),
      providerFeeKobo: koboNumber(takenFee),
      wawuFeeKobo: 0,
      figuresStand: fee === null,
      counterparty: {
        kind: 'wawu_user',
        name: null,
        wawuUserId: r.userWawuId,
        accountNumber: dest,
      },
    };
    const inn: LedgerMovementInput = {
      ...common,
      wallet: { kind: 'user', wawuUserId: r.userWawuId, accountNumber: dest },
      direction: 'in',
      amountKobo: amount,
      feeKobo: 0,
      totalKobo: amount,
      counterparty: { kind: 'wawu', name: null },
    };
    for (const movement of [out, inn]) {
      try {
        await this.ledger.record(movement, undefined, { quiet: true });
      } catch (e) {
        this.logger.error(
          `refund ${r.id}: the ledger could not record the refund (${e instanceof Error ? e.name : 'error'})`,
        );
      }
    }
  }

  private expectedFeeKobo(amount: bigint): bigint | null {
    if (!this.fees.feesSet) return null;
    try {
      return BigInt(
        this.fees.providerFees.walletToWalletKobo(safeKoboNumber(amount)),
      );
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Waiting and review
  // -------------------------------------------------------------------------

  private async waitFor(
    r: RefundRow,
    waiting: PassRefundWaiting,
    now: Date,
    slow = false,
  ): Promise<PassRefundResult> {
    if (r.waiting !== waiting) {
      this.logger.warn(
        `refund ${r.id}: waits (${waiting}); the money stays in WAWU's account`,
      );
    }
    const rest =
      waiting === 'member_wallet'
        ? walletWaitRestMs(now.getTime() - r.createdAt.getTime())
        : slow
          ? 60 * MINUTE
          : restMs(Math.max(r.attempts, 1));
    await this.prisma.communityPassRefund.updateMany({
      where: { id: r.id, status: 'pending', sentAt: null },
      data: { waiting, nextAttemptAt: new Date(now.getTime() + rest) },
    });
    return this.resultOf(await this.load(r.id));
  }

  /** Out of the sweep, for a person to look at. The money stays where it is. */
  private async toReview(
    r: RefundRow,
    note: string,
  ): Promise<PassRefundResult> {
    const { count } = await this.prisma.communityPassRefund.updateMany({
      where: { id: r.id, status: 'pending', reviewSince: null },
      data: {
        reviewSince: new Date(),
        nextAttemptAt: null,
        discrepancy: r.discrepancy ? `${r.discrepancy}; ${note}` : note,
      },
    });
    if (count > 0) this.logger.error(`refund ${r.id}: ${note}; sent to review`);
    return this.resultOf(await this.load(r.id));
  }

  private load(id: string): Promise<RefundRow> {
    return this.prisma.communityPassRefund.findUniqueOrThrow({ where: { id } });
  }

  private resultOf(r: RefundRow): PassRefundResult {
    let state: PassRefundState;
    if (r.status !== 'pending') state = 'refunded';
    else if (r.reviewSince) state = 'review';
    else if (r.sentAt) state = 'pending';
    else state = 'waiting';
    return {
      refundId: r.id,
      state,
      waiting:
        state === 'waiting'
          ? ((r.waiting as PassRefundWaiting | null) ?? null)
          : null,
    };
  }
}
