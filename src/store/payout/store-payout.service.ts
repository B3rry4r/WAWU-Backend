import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '../../../generated/prisma/client';
import type { StoreEarning } from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { PaymentKind } from '../../money/dto/money-enums';
import type { LedgerMovementInput } from '../../money/ledger/ledger.interface';
import { koboNumber, LedgerService } from '../../money/ledger/ledger.service';
import { isUniqueViolation } from '../../money/prisma-unique';
import { isRowOf } from '../../wallet-provider/provider-rows';
import {
  type ProviderPlatformAccount,
  type ProviderReconciliation,
  type ProviderTransferReceipt,
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import { WalletProviderError } from '../../wallet-provider/wallet-provider-error';
import { WalletProviderLimitError } from '../../wallet-provider/wallet-provider-limit';
import { StoreAdminNoticeService } from './store-admin-notice.service';
import {
  lagosDayKey,
  netAgainstDeductions,
  PAYOUT_NARRATION,
  PAYOUT_PAGE,
  PAYOUT_REVIEW_AFTER_HOURS,
  PAYOUT_SWEEP_BUDGET_MS,
  type PayoutWaiting,
  payoutReference,
  restMs,
} from './store-payout-rules';

type PayoutRow = Prisma.StoreEarningPayoutGetPayload<object>;

export type PayoutState =
  'paid' | 'pending' | 'waiting' | 'review' | 'cancelled';

export interface PayoutResult {
  payoutId: string;
  state: PayoutState;
  waiting: PayoutWaiting | null;
}

/** Thrown inside the planning transaction when WAWU's account cannot cover the next payout: the whole write is undone. */
class ShortOfFunds extends Error {}

/** What a pass of the sweep did, for logs and tests. */
export interface PayoutSweepCounts {
  /** Payouts made (an earning netted against deductions and, if it had a net, handed to the transfer step). */
  planned: number;
  /** Payouts looked at to send or to ask the provider about. */
  checked: number;
  /** Payouts the provider confirmed in this pass. */
  paid: number;
  /** True when WAWU's account could not cover every due earning. */
  short: boolean;
}

/**
 * Pays a creator's 85% of a store sale (task STORE-PAYOUT, R-101 point 4, owner
 * 27 Oct 2026: "Paying the users would be from our own pocket our own nuvion
 * wallet in 3 working days").
 *
 * **What is paid.** Each `StoreEarning` whose `availableAt` has passed (the sale
 * plus 3 working days, Lagos, weekends and `store.holidays` skipped): the
 * creator's share, less what their open `EarningDeduction`s take of it, oldest
 * first and never below 0, is moved from WAWU's own account at the wallet
 * provider to the creator's wallet, through `WALLET_PROVIDER` only (R-39). One
 * `StoreEarningPayout` row per earning carries the figures and the takes, and
 * its `customerReference` is the idempotency key at the provider.
 *
 * **Exactly once.** The row is unique per earning and made under a lock on the
 * earning; the transfer is handed over under a lease (`sentAt`) only one caller
 * wins; the provider refuses a repeated reference. Two runs, two servers and a
 * restart pay an earning once. The earning is `sending` while the transfer is
 * out (a store refund then becomes a deduction, as for a paid one) and `paid`
 * only once the provider confirmed it. A refund before anything is sent cancels
 * the earning, and the payout with it (its takes are given back).
 *
 * **The provider's record is the truth.** As for every mover here: a transfer
 * whose outcome is unknown is asked about, never sent again; only the
 * provider's own record that it FAILED starts a new try under a new reference;
 * past 72 hours a person looks. Both sides go to the ledger under our
 * reference, so the ledger equals the provider.
 *
 * **Waiting is not failing.** A creator with no wallet has no payout yet: the
 * earning stays owed and is picked up within a minute of the wallet opening
 * (R-11). A frozen wallet or a provider out of reach waits and is tried again.
 * WAWU's own account short of money pays in `availableAt` order up to what it
 * holds, leaves the rest owed, and tells the owner once a day (an admin notice).
 *
 * A server acts only on payouts of the provider it runs.
 */
@Injectable()
export class StorePayoutService {
  private readonly logger = new Logger(StorePayoutService.name);
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(WALLET_PROVIDER) private readonly provider: WalletProvider,
    private readonly ledger: LedgerService,
    private readonly notices: StoreAdminNoticeService,
  ) {}

  // -------------------------------------------------------------------------
  // The sweep
  // -------------------------------------------------------------------------

  /** Every minute: pay what is due, then drive every payout that is waiting or unconfirmed. */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'store-earning-payout' })
  async sweep(
    now = new Date(),
    opts: { budgetMs?: number } = {},
  ): Promise<PayoutSweepCounts> {
    const counts: PayoutSweepCounts = {
      planned: 0,
      checked: 0,
      paid: 0,
      short: false,
    };
    if (this.sweeping) return counts;
    this.sweeping = true;
    const budgetMs = opts.budgetMs ?? PAYOUT_SWEEP_BUDGET_MS;
    const started = Date.now();
    try {
      const planned = await this.plan(now, started, budgetMs);
      counts.planned = planned.made;
      counts.short = planned.short;
      const skip: string[] = [];
      for (;;) {
        const due = await this.prisma.storeEarningPayout.findMany({
          where: {
            status: 'pending',
            reviewSince: null,
            provider: this.provider.name,
            OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
            id: { notIn: skip },
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: PAYOUT_PAGE,
          select: { id: true },
        });
        for (const { id } of due) {
          skip.push(id);
          counts.checked += 1;
          try {
            const r = await this.drive(id, now);
            if (r.state === 'paid') counts.paid += 1;
          } catch (e) {
            this.logger.error(
              `store payout ${id}: the sweep could not drive it (${e instanceof Error ? `${e.name}: ${e.message.slice(0, 160)}` : 'error'})`,
            );
          }
          if (Date.now() - started >= budgetMs) return counts;
        }
        if (due.length < PAYOUT_PAGE) break;
      }
    } catch (e) {
      this.logger.error(
        `store payout sweep failed: ${e instanceof Error ? e.message : 'unknown'}`,
      );
    } finally {
      this.sweeping = false;
    }
    return counts;
  }

  /**
   * Makes the payout of every due earning whose creator has a wallet, in
   * `availableAt` order, while WAWU's account can cover it. The account's
   * balance is the provider's, read once here (a read, no lock held); what
   * payouts already made and not yet sent will take is taken off it first.
   */
  private async plan(
    now: Date,
    started: number,
    budgetMs: number,
  ): Promise<{ made: number; short: boolean }> {
    const provider = this.provider.name;
    let account: ProviderPlatformAccount;
    try {
      account = await this.provider.getPlatformAccount();
    } catch (e) {
      this.logger.warn(
        `store payout: ${this.provider.label} could not say what WAWU's account holds (${e instanceof WalletProviderError ? e.kind : 'error'}); no new payout is made this pass`,
      );
      return { made: 0, short: false };
    }
    const committed = await this.prisma.storeEarningPayout.aggregate({
      where: {
        status: 'pending',
        sentAt: null,
        reviewSince: null,
        provider,
      },
      _sum: { amountKobo: true },
    });
    let available = account.availableKobo - (committed._sum.amountKobo ?? 0n);
    let made = 0;
    let short = false;
    const skip: string[] = [];
    for (;;) {
      const page = await this.prisma.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`
          SELECT e."id" FROM "StoreEarning" e
           WHERE e."status" = 'owed' AND e."availableAt" <= ${now}
             AND e."provider" = ${provider}
             AND NOT (e."id" = ANY(${skip}::text[]))
             AND NOT EXISTS (SELECT 1 FROM "StoreEarningPayout" p WHERE p."storeEarningId" = e."id")
             AND EXISTS (
               SELECT 1 FROM "FintavaWallet" w
                WHERE w."wawuUserId" = e."payeeWawuUserId"
                  AND LOWER(BTRIM(COALESCE(w."provider", 'fintava'))) = ${provider})
           ORDER BY e."availableAt" ASC, e."id" ASC
           LIMIT ${PAYOUT_PAGE}`,
      );
      for (const { id } of page) {
        let spent: bigint | null;
        try {
          spent = await this.planOne(id, now, account.accountNumber, available);
        } catch (e) {
          if (e instanceof ShortOfFunds) {
            short = true;
            break;
          }
          this.logger.error(
            `store earning ${id}: its payout could not be made (${e instanceof Error ? `${e.name}: ${e.message.slice(0, 160)}` : 'error'})`,
          );
          spent = null;
        }
        if (short) break;
        if (spent === null) skip.push(id);
        else {
          made += 1;
          available -= spent;
        }
        if (Date.now() - started >= budgetMs) return { made, short };
      }
      if (short || page.length < PAYOUT_PAGE) break;
    }
    if (short) await this.tellShort(now, account.availableKobo);
    return { made, short };
  }

  /**
   * One earning's payout, made in one short transaction (nothing is sent in
   * it): the earning is locked, the creator's open deductions are locked and
   * taken oldest first up to the share, and the row and its takes are written.
   * An earning whose net is 0 is paid in the same write: nothing moves. Returns
   * what the payout will take from WAWU's account (0 for a netted one), or null
   * when there was nothing to make (another caller made it, the sale was
   * refunded, the wallet is gone). Throws `ShortOfFunds` when the net is more
   * than `available`: nothing is written.
   */
  private async planOne(
    id: string,
    now: Date,
    merchantAccountNumber: string,
    available: bigint,
  ): Promise<bigint | null> {
    const provider = this.provider.name;
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const locked = await tx.$queryRaw<Array<{ id: string }>>(
            Prisma.sql`
              SELECT "id" FROM "StoreEarning"
               WHERE "id" = ${id} AND "status" = 'owed' AND "availableAt" <= ${now}
                 AND "provider" = ${provider}
                 FOR UPDATE`,
          );
          if (locked.length === 0) return null;
          const earning = await tx.storeEarning.findUniqueOrThrow({
            where: { id },
          });
          const had = await tx.storeEarningPayout.findUnique({
            where: { storeEarningId: id },
            select: { id: true },
          });
          if (had !== null) return null;
          const wallet = await tx.fintavaWallet.findUnique({
            where: { wawuUserId: earning.payeeWawuUserId },
            select: { accountNumber: true, provider: true },
          });
          if (!wallet || !isRowOf(provider, wallet.provider)) return null;

          const open = await tx.$queryRaw<Array<{ id: string; owed: string }>>(
            Prisma.sql`
              SELECT d."id",
                     (d."amountKobo" - COALESCE((SELECT SUM(t."amountKobo")
                                                   FROM "EarningDeductionTake" t
                                                  WHERE t."deductionId" = d."id"), 0))::text AS "owed"
                FROM "EarningDeduction" d
               WHERE d."payeeWawuUserId" = ${earning.payeeWawuUserId}
                 AND d."provider" = ${provider}
                 AND d."amountKobo" > COALESCE((SELECT SUM(t."amountKobo")
                                                  FROM "EarningDeductionTake" t
                                                 WHERE t."deductionId" = d."id"), 0)
               ORDER BY d."createdAt" ASC, d."id" ASC
                 FOR UPDATE OF d`,
          );
          const netting = netAgainstDeductions(
            earning.amountKobo,
            open.map((d) => ({ id: d.id, owedKobo: BigInt(d.owed) })),
          );
          if (netting.netKobo > available) throw new ShortOfFunds();

          const payout = await tx.storeEarningPayout.create({
            data: {
              storeEarningId: id,
              payeeWawuUserId: earning.payeeWawuUserId,
              provider,
              grossKobo: earning.amountKobo,
              deductedKobo: netting.deductedKobo,
              amountKobo: netting.netKobo,
              merchantAccountNumber,
              destinationAccountNumber: wallet.accountNumber,
              customerReference: payoutReference(id, 1),
              ...(netting.netKobo === 0n
                ? { status: 'paid', settledAt: now }
                : {}),
            },
          });
          if (netting.takes.length > 0) {
            await tx.earningDeductionTake.createMany({
              data: netting.takes.map((t) => ({
                deductionId: t.deductionId,
                storePayoutId: payout.id,
                amountKobo: t.kobo,
              })),
            });
          }
          if (netting.netKobo === 0n) {
            await tx.storeEarning.update({
              where: { id },
              data: { status: 'paid', paidAt: now },
            });
          }
          return netting.netKobo;
        },
        { maxWait: 10_000, timeout: 30_000 },
      );
    } catch (e) {
      // Another server made this payout first: theirs stands.
      if (isUniqueViolation(e)) return null;
      throw e;
    }
  }

  /**
   * The owner is told, once a day, that WAWU's account could not cover what
   * creators are owed. The day's key makes any number of passes and servers
   * write one notice.
   */
  private async tellShort(now: Date, availableKobo: bigint): Promise<void> {
    try {
      const provider = this.provider.name;
      const owed = await this.prisma.$queryRaw<
        Array<{ n: string; kobo: string | null }>
      >(Prisma.sql`
        SELECT COUNT(*)::text AS "n", COALESCE(SUM(e."amountKobo"), 0)::text AS "kobo"
          FROM "StoreEarning" e
         WHERE e."status" = 'owed' AND e."availableAt" <= ${now}
           AND e."provider" = ${provider}
           AND NOT EXISTS (SELECT 1 FROM "StoreEarningPayout" p WHERE p."storeEarningId" = e."id")
           AND EXISTS (
             SELECT 1 FROM "FintavaWallet" w
              WHERE w."wawuUserId" = e."payeeWawuUserId"
                AND LOWER(BTRIM(COALESCE(w."provider", 'fintava'))) = ${provider})`);
      const n = Number(owed[0]?.n ?? 0);
      const kobo = BigInt(owed[0]?.kobo ?? '0');
      const day = lagosDayKey(now);
      const wrote = await this.notices.once({
        kind: 'store_payout_short',
        noticeKey: `store_payout_short:${day}`,
        title: "WAWU's account is short for creator payouts",
        body: `WAWU's account holds ${naira(availableKobo)}. ${n} store ${n === 1 ? 'earning' : 'earnings'} worth ${naira(kobo)} ${n === 1 ? 'is' : 'are'} due to creators and wait for money to be added. They are paid in the order they fell due as soon as it is.`,
        data: {
          day,
          availableKobo: availableKobo.toString(),
          owedKobo: kobo.toString(),
          earnings: n,
        },
      });
      if (wrote)
        this.logger.error(
          `store payout: WAWU's account holds ${availableKobo} kobo and ${n} earnings (${kobo} kobo) are due; the owner has been told`,
        );
    } catch (e) {
      this.logger.error(
        `store payout: the shortage notice could not be written (${e instanceof Error ? e.name : 'error'})`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // One step
  // -------------------------------------------------------------------------

  /** Moves a payout one step: asks the provider about a transfer that was handed over, or hands it over. */
  async drive(payoutId: string, now = new Date()): Promise<PayoutResult> {
    const r = await this.load(payoutId);
    if (r.status !== 'pending' || r.reviewSince) return this.resultOf(r);
    if (r.nextAttemptAt && r.nextAttemptAt.getTime() > now.getTime()) {
      return this.resultOf(r);
    }
    if (!isRowOf(this.provider.name, r.provider)) {
      return this.waitFor(r, 'provider', now, true);
    }
    return r.sentAt ? this.reconcile(r, now) : this.send(r, now);
  }

  private async send(r: PayoutRow, now: Date): Promise<PayoutResult> {
    const wallet = await this.prisma.fintavaWallet.findUnique({
      where: { wawuUserId: r.payeeWawuUserId },
      select: { accountNumber: true, provider: true },
    });
    if (!wallet || !isRowOf(this.provider.name, wallet.provider)) {
      return this.waitFor(r, 'payee_wallet', now);
    }
    if (
      await this.isWawuAccount(r.merchantAccountNumber, wallet.accountNumber)
    ) {
      return this.toReview(
        r,
        "the payout would move money from WAWU's account to WAWU's account",
      );
    }

    // The lease: only the caller that wins it hands the transfer to the
    // provider. It is won under a lock on the earning, so a store refund
    // cannot slip in between: before this, the refund cancels the earning and
    // the payout with it; after it, the earning is `sending` and the refund is
    // a deduction.
    const leaseUntil = new Date(
      now.getTime() +
        this.provider.timings.moneyTimeoutMs +
        this.provider.timings.resendSafetyMs,
    );
    const leased = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ status: string }>>(
        Prisma.sql`SELECT "status" FROM "StoreEarning" WHERE "id" = ${r.storeEarningId} FOR UPDATE`,
      );
      const status = rows[0]?.status;
      if (status === 'cancelled' || status === undefined) {
        await this.cancelIn(tx, r.id);
        return 'cancelled' as const;
      }
      if (status === 'owed') {
        await tx.storeEarning.update({
          where: { id: r.storeEarningId },
          data: { status: 'sending' },
        });
      }
      const won = await tx.storeEarningPayout.updateMany({
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
      return won.count === 1 ? ('won' as const) : ('lost' as const);
    });
    if (leased === 'cancelled') {
      this.logger.warn(
        `store payout ${r.id}: the sale was refunded before anything was sent; the payout is cancelled`,
      );
      return this.resultOf(await this.load(r.id));
    }
    if (leased === 'lost') return this.resultOf(await this.load(r.id));

    let receipt: ProviderTransferReceipt;
    try {
      receipt = await this.provider.walletToWallet({
        fromAccountNumber: r.merchantAccountNumber,
        toAccountNumber: wallet.accountNumber,
        amountKobo: r.amountKobo,
        reference: r.customerReference,
        narration: PAYOUT_NARRATION,
      });
    } catch (e) {
      return this.afterRefusal(r, e, now);
    }
    return this.afterReceipt(
      { ...r, destinationAccountNumber: wallet.accountNumber },
      receipt,
      now,
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

  /** The provider did not take the transfer, or we do not know whether it did. */
  private async afterRefusal(
    r: PayoutRow,
    e: unknown,
    now: Date,
  ): Promise<PayoutResult> {
    const refusal = e instanceof WalletProviderError ? e : null;
    if (refusal?.providerFailed) {
      // The provider TOOK the transfer and its own record says it failed: read the record.
      return this.reconcile(r, now);
    }
    if (!refusal || (refusal.recordMayExist && !refusal.requestNotSent)) {
      // Money may have moved: asked about, never sent again.
      this.logger.warn(
        `store payout ${r.id}: the outcome is unknown (${refusal?.kind ?? 'error'}); asking ${this.provider.label} about it`,
      );
      await this.schedule(r, now, 1);
      return this.resultOf(await this.load(r.id));
    }
    let waiting: PayoutWaiting;
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
        `store payout ${r.id}: ${this.provider.label} says WAWU's own account cannot cover the payout (${r.amountKobo} kobo)`,
      );
      await this.tellShort(now, 0n);
    } else if (waiting === 'refused') {
      this.logger.error(
        `store payout ${r.id}: ${this.provider.label} refused the payout (${refusal.kind}); nothing moved`,
      );
    }
    // Nothing moved: the lease is given back, the earning is owed again, and
    // the same reference is used on the next try.
    await this.prisma.$transaction(async (tx) => {
      await tx.storeEarningPayout.updateMany({
        where: { id: r.id, status: 'pending', sentAt: { not: null } },
        data: {
          sentAt: null,
          waiting,
          nextAttemptAt: new Date(now.getTime() + restMs(r.attempts + 1)),
        },
      });
      await tx.storeEarning.updateMany({
        where: { id: r.storeEarningId, status: 'sending' },
        data: { status: 'owed' },
      });
    });
    if (waiting === 'refused' && this.refusedTooLong(r, now)) {
      return this.toReview(
        r,
        `the payout has been refused for ${PAYOUT_REVIEW_AFTER_HOURS} hours`,
      );
    }
    return this.resultOf(await this.load(r.id));
  }

  private refusedTooLong(r: PayoutRow, now: Date): boolean {
    return (
      now.getTime() - r.createdAt.getTime() >=
      PAYOUT_REVIEW_AFTER_HOURS * 3_600_000
    );
  }

  /** The provider confirmed the transfer in its answer. */
  private async afterReceipt(
    r: PayoutRow,
    receipt: ProviderTransferReceipt,
    now: Date,
  ): Promise<PayoutResult> {
    if (receipt.amountKobo !== r.amountKobo) {
      return this.toReview(
        r,
        `${this.provider.label} moved ${receipt.amountKobo} kobo for a payout of ${r.amountKobo} kobo`,
      );
    }
    if (receipt.pending === true) {
      // Accepted and not finished: neither paid nor failed. Asked about, never sent again.
      await this.schedule(r, now, 1);
      return this.resultOf(await this.load(r.id));
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
  // Asking the provider about a transfer that was handed over
  // -------------------------------------------------------------------------

  private async reconcile(r: PayoutRow, now: Date): Promise<PayoutResult> {
    let answer: ProviderReconciliation | null = null;
    try {
      answer = await this.provider.reconcileSend(
        r.customerReference,
        { kind: 'merchant' },
        r.sentAt ?? r.createdAt,
      );
    } catch (e) {
      this.logger.warn(
        `store payout ${r.id}: ${this.provider.label} could not be asked (${e instanceof WalletProviderError ? e.kind : 'error'})`,
      );
    }
    if (answer?.state === 'found') {
      const t = answer.transaction;
      if (t.outcome === 'completed') {
        if (t.amountKobo !== r.amountKobo) {
          return this.toReview(
            r,
            `${this.provider.label} moved ${t.amountKobo} kobo for a payout of ${r.amountKobo} kobo`,
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
        // The provider's own record: the money is where it was. Only this starts a new try, under a new reference.
        return this.retryAfterFailure(r, now);
      }
      if (t.outcome === 'reversed') {
        return this.toReview(
          r,
          `${this.provider.label} moved the payout and then reversed it; WAWU's account holds the money again`,
        );
      }
      // Pending, or a word we do not know: neither says no money moved.
    }
    return this.stillUnknown(r, now);
  }

  private async stillUnknown(r: PayoutRow, now: Date): Promise<PayoutResult> {
    const since = (r.sentAt ?? r.createdAt).getTime();
    if (now.getTime() - since >= PAYOUT_REVIEW_AFTER_HOURS * 3_600_000) {
      return this.toReview(
        r,
        `no answer from ${this.provider.label} about the payout after ${PAYOUT_REVIEW_AFTER_HOURS} hours; it may have moved`,
      );
    }
    await this.schedule(r, now, r.checks + 1);
    return this.resultOf(await this.load(r.id));
  }

  private async schedule(
    r: PayoutRow,
    now: Date,
    checks: number,
  ): Promise<void> {
    await this.prisma.storeEarningPayout.updateMany({
      where: { id: r.id, status: 'pending' },
      data: {
        checks: { increment: 1 },
        nextAttemptAt: new Date(now.getTime() + restMs(checks)),
      },
    });
  }

  /** The provider's record says the transfer failed: one new try, under a new reference. */
  private async retryAfterFailure(
    r: PayoutRow,
    now: Date,
  ): Promise<PayoutResult> {
    const attempt = r.attempt + 1;
    this.logger.warn(
      `store payout ${r.id}: ${this.provider.label} says the payout failed; trying again as attempt ${attempt}`,
    );
    await this.prisma.$transaction(async (tx) => {
      await tx.storeEarningPayout.updateMany({
        where: {
          id: r.id,
          status: 'pending',
          sentAt: { not: null },
          customerReference: r.customerReference,
        },
        data: {
          attempt,
          customerReference: payoutReference(r.storeEarningId, attempt),
          sentAt: null,
          checks: 0,
          waiting: 'refused',
          nextAttemptAt: new Date(now.getTime() + restMs(attempt)),
        },
      });
      await tx.storeEarning.updateMany({
        where: { id: r.storeEarningId, status: 'sending' },
        data: { status: 'owed' },
      });
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
        `the payout has failed at ${this.provider.label} for ${PAYOUT_REVIEW_AFTER_HOURS} hours`,
      );
    }
    return this.resultOf(fresh);
  }

  // -------------------------------------------------------------------------
  // Settling
  // -------------------------------------------------------------------------

  /** The provider confirmed: both sides go to the ledger, then the payout and the earning are paid in one write. */
  private async settle(
    r: PayoutRow,
    fig: {
      feeKobo: bigint | null;
      refs: {
        fintavaReference?: string | null;
        tagapayTransRef?: string | null;
        fintavaTransactionId?: string | null;
      };
      occurredAt: Date | null;
    },
  ): Promise<PayoutResult> {
    const fee = fig.feeKobo !== null && fig.feeKobo >= 0n ? fig.feeKobo : null;
    await this.writeLedger(r, fee, fig.refs, fig.occurredAt);
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.storeEarningPayout.updateMany({
        where: { id: r.id, status: 'pending' },
        data: {
          status: 'paid',
          settledAt: now,
          providerFeeKobo: fee,
          waiting: null,
          nextAttemptAt: null,
        },
      });
      await tx.storeEarning.updateMany({
        where: {
          id: r.storeEarningId,
          status: { in: ['owed', 'sending'] },
        },
        data: { status: 'paid', paidAt: now },
      });
    });
    return this.resultOf(await this.load(r.id));
  }

  /**
   * Both sides of the transfer in the ledger under our reference: WAWU's
   * account (money out) and the creator's wallet (money in), category
   * `earning`, linked to what was sold, so the creator sees it land as the
   * store sale it is. Best effort, like every ledger write after the money
   * moved; recording the same reference again changes nothing.
   */
  private async writeLedger(
    r: PayoutRow,
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
    const earning: StoreEarning | null = await this.prisma.storeEarning
      .findUnique({ where: { id: r.storeEarningId } })
      .catch(() => null);
    const amount = koboNumber(r.amountKobo);
    const common = {
      status: 'completed' as const,
      category: 'earning' as const,
      link: earning
        ? {
            kind: earning.kind as PaymentKind,
            targetId: earning.targetId,
            title: earning.title,
          }
        : null,
      narration: PAYOUT_NARRATION,
      references: { customerReference: r.customerReference, ...refs },
      source: 'send' as const,
      ...(occurredAt ? { occurredAt } : {}),
    };
    const takenFee = fee ?? 0n;
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
        wawuUserId: r.payeeWawuUserId,
        accountNumber: dest,
      },
    };
    const inn: LedgerMovementInput = {
      ...common,
      wallet: {
        kind: 'user',
        wawuUserId: r.payeeWawuUserId,
        accountNumber: dest,
      },
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
          `store payout ${r.id}: the ledger could not record the payout (${e instanceof Error ? e.name : 'error'})`,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Waiting, review, cancelling
  // -------------------------------------------------------------------------

  private async waitFor(
    r: PayoutRow,
    waiting: PayoutWaiting,
    now: Date,
    slow = false,
  ): Promise<PayoutResult> {
    if (r.waiting !== waiting) {
      this.logger.warn(
        `store payout ${r.id}: waits (${waiting}); the money stays in WAWU's account`,
      );
    }
    const rest = slow ? 60 * 60_000 : restMs(Math.max(r.attempts, 1));
    await this.prisma.storeEarningPayout.updateMany({
      where: { id: r.id, status: 'pending', sentAt: null },
      data: { waiting, nextAttemptAt: new Date(now.getTime() + rest) },
    });
    return this.resultOf(await this.load(r.id));
  }

  /** Out of the sweep, for a person to look at. The money stays where it is. */
  private async toReview(r: PayoutRow, note: string): Promise<PayoutResult> {
    const { count } = await this.prisma.storeEarningPayout.updateMany({
      where: { id: r.id, status: 'pending', reviewSince: null },
      data: {
        reviewSince: new Date(),
        nextAttemptAt: null,
        discrepancy: r.discrepancy ? `${r.discrepancy}; ${note}` : note,
      },
    });
    if (count > 0)
      this.logger.error(`store payout ${r.id}: ${note}; sent to review`);
    return this.resultOf(await this.load(r.id));
  }

  /** The sale was refunded before anything was sent: the payout ends and its takes are given back. */
  private async cancelIn(
    tx: Prisma.TransactionClient,
    payoutId: string,
  ): Promise<void> {
    await tx.earningDeductionTake.deleteMany({
      where: { storePayoutId: payoutId },
    });
    await tx.storeEarningPayout.updateMany({
      where: { id: payoutId, status: 'pending', sentAt: null },
      data: { status: 'cancelled', nextAttemptAt: null, waiting: null },
    });
  }

  private load(id: string): Promise<PayoutRow> {
    return this.prisma.storeEarningPayout.findUniqueOrThrow({ where: { id } });
  }

  private resultOf(r: PayoutRow): PayoutResult {
    let state: PayoutState;
    if (r.status === 'paid') state = 'paid';
    else if (r.status === 'cancelled') state = 'cancelled';
    else if (r.reviewSince) state = 'review';
    else if (r.sentAt) state = 'pending';
    else state = 'waiting';
    return {
      payoutId: r.id,
      state,
      waiting:
        state === 'waiting'
          ? ((r.waiting as PayoutWaiting | null) ?? null)
          : null,
    };
  }
}

/** ₦ with thousands separators and the kobo only when there are some. */
function naira(kobo: bigint): string {
  const whole = kobo / 100n;
  const cents = kobo % 100n;
  const w = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `₦${w}${cents === 0n ? '' : `.${cents.toString().padStart(2, '0')}`}`;
}
