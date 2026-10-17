import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { FeeQuoteService } from '../../money/fees/fee-quote.service';
import type { LedgerMovementInput } from '../../money/ledger/ledger.interface';
import { koboNumber, LedgerService } from '../../money/ledger/ledger.service';
import { MoneyError } from '../../money/money-error';
import { MerchantWallet } from '../../money/payments/merchant-wallet';
import {
  type IdempotencyScope,
  IdempotencyService,
} from '../../money/payments/idempotency';
import { PaymentSettings } from '../../money/payments/payment-config';
import { joinNotes } from '../../money/payments/payment-figures';
import { isRowOf } from '../../wallet-provider/provider-rows';
import {
  type ProviderReconciliation,
  type ProviderTransferReceipt,
  safeKoboNumber,
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import { WalletProviderError } from '../../wallet-provider/wallet-provider-error';
import { PointsError } from '../points-error';
import { POINTS_WORD } from '../points-words';
import { PointsService } from '../points.service';
import {
  CASH_OUT_HOLD_TITLE,
  CASH_OUT_NARRATION,
  CONVERSION_SWEEP_BUDGET_MS,
  CONVERSION_SWEEP_GRACE_MS,
  CONVERSION_SWEEP_PAGE,
  CONVERSION_WORDS,
  type CancelReason,
  type ConversionResult,
  type ConversionState,
  type ConversionStatus,
  type ConversionSweepCursor,
  conversionReference,
  provedNothingMoved,
} from './points-convert-rules';
import type {
  PointsConversionStatus,
  PointsConversionView,
} from './points-convert-view.type';

type ConversionRow = Prisma.PointConversionGetPayload<object>;

const MINUTE = 60_000;

/** The route key of the Idempotency-Key row (`method route`, as the pay route's). */
export const CONVERT_ROUTE = 'POST points/convert';

/** The rest before the next question: 1, 2, 4 ... minutes, at most an hour. */
function restMs(count: number): number {
  return Math.min(60, 2 ** Math.min(Math.max(count, 0), 6)) * MINUTE;
}

/** The answer stored for every repeat of a key: the envelope the interceptor writes. */
export function conversionBody(view: PointsConversionView): string {
  return JSON.stringify({ statusCode: 200, message: 'OK', data: view });
}

/** What a caller of `start` asks for: already checked against the minimum, the balance and the cap. */
export interface StartConversion {
  wawuUserId: string;
  points: number;
  /** The config's rate when it was asked: kobo for 1,000 points. */
  per1000PointsKobo: number;
  /** The cash for `points` at that rate, in kobo (`cashForPoints`). */
  cashKobo: bigint;
  scope: IdempotencyScope;
}

/**
 * Points turned into cash in the person's wallet (task POINTS-04, R-43, R-31).
 *
 * `start` writes the conversion and holds the points in ONE transaction (the
 * hold last, as POINTS-01 asks of every caller), then asks WAWU's own account
 * at the wallet provider to pay the cash into the person's wallet. The hold
 * is committed, in the same transaction that marks the conversion `paid`, only
 * once the provider CONFIRMED the move; when its own record says nothing
 * moved, the hold is released (back to the lots it came from, with their own
 * end dates) in the same transaction that marks the conversion `cancelled`.
 * The database holds the same rule: at commit a conversion and its hold agree
 * (the migration's deferred trigger).
 *
 * **Once.** One request is one conversion (the Idempotency-Key links to it),
 * one conversion is one reference at the provider (`wawu-pts-<id>`, unique in
 * our table and refused as a repeat by the provider), and the move is handed
 * over by a lease (`sentAt`) only one caller wins. So a retry, a replay, two
 * Hub processes or a kill between any two steps never moves the cash twice
 * and never spends the points twice. A conversion the provider did not make
 * is cancelled; asking again is a new conversion with a new reference.
 *
 * **The provider's record is the truth.** A move whose outcome is unknown (a
 * timeout, a 5xx, a transfer accepted and not finished, a repeated reference,
 * a Hub killed between the provider's answer and our write) is asked about by
 * our reference, backing off to hourly, and is never sent again and never read
 * as "nothing moved". The points stay HELD meanwhile: they are not released
 * blindly and no timer releases them. Past PAYMENT_REVIEW_AFTER_HOURS it goes
 * to a person (`reviewSince`), still held. Only a refusal that PROVES nothing
 * moved (the provider said so, or the request never reached it) or the
 * provider's own record that the move failed gives the points back.
 *
 * **No waiting on a provider under a points lock.** The provider is called
 * outside every transaction. The two transactions that touch the person's
 * points (`start`, `land`, `cancel`) call the points service last and hold
 * nothing else of the person's.
 *
 * The cash leaves WAWU's own account (Fintava's merchant wallet or Nuvion's
 * operational account, whichever `WALLET_PROVIDER` runs) and the ledger shows
 * it as WAWU's movement (link kind `points_cash_out`). The provider's charge
 * on the move is WAWU's (R-31): the person receives the whole figure.
 *
 * Through the provider seam only (MONEY-20): a server acts only on
 * conversions of the provider it runs.
 */
@Injectable()
export class PointsCashOutService implements OnModuleInit {
  private readonly logger = new Logger(PointsCashOutService.name);
  private sweeping = false;
  /** Where the last pass stopped when its time ran out; null once it has read to the end. */
  private sweepAfter: ConversionSweepCursor | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(WALLET_PROVIDER) private readonly provider: WalletProvider,
    private readonly ledger: LedgerService,
    private readonly fees: FeeQuoteService,
    private readonly settings: PaymentSettings,
    private readonly points: PointsService,
    private readonly keys: IdempotencyService,
    private readonly merchant: MerchantWallet,
  ) {}

  onModuleInit(): void {
    // A key left `in_progress` by a request that died after it made the
    // conversion (a restart, a kill) is answered from that conversion once the
    // request can no longer be running.
    this.keys.onStale(
      CONVERT_ROUTE,
      this.provider.timings.moneyTimeoutMs + MINUTE,
      async (row) => {
        const c = row.resourceId
          ? await this.prisma.pointConversion.findUnique({
              where: { id: row.resourceId },
            })
          : null;
        return c ? { status: 201, body: conversionBody(this.view(c)) } : null;
      },
    );
  }

  // -------------------------------------------------------------------------
  // What the route calls
  // -------------------------------------------------------------------------

  /**
   * Makes the conversion, holds the points, asks the provider to pay, and
   * answers where it stands. The answer is stored for every repeat of the
   * key (`Idempotent-Replayed`).
   *
   * Refused before anything is written, the key given back: the person's
   * wallet is another provider's (`provider_unreachable`), WAWU's own account
   * cannot be read (`provider_unreachable`), or the person has fewer points
   * than asked (`insufficient_points`, from the hold, which checks again
   * under the person's points lock).
   */
  async start(input: StartConversion): Promise<PointsConversionView> {
    const wallet = await this.prisma.fintavaWallet.findUnique({
      where: { wawuUserId: input.wawuUserId },
      select: { accountNumber: true, provider: true },
    });
    if (!wallet) {
      throw new MoneyError(
        'wallet_not_open',
        "You don't have a wallet yet. Open your wallet to continue.",
      );
    }
    if (!isRowOf(this.provider.name, wallet.provider)) {
      this.logger.warn(
        `points to cash: the wallet is held by another provider than ${this.provider.label}; nothing is held or sent`,
      );
      throw new MoneyError(
        'provider_unreachable',
        'Payments are not available right now. Your points are safe. Try again in a moment.',
        { retryAfterSeconds: this.provider.timings.retryAfterSeconds },
      );
    }
    // WAWU's own account, as the provider names it; read once per process.
    // Nothing is written yet, so it is the person's points that are safe
    // (SWEEP-MONEY POINTS-04 L3), not their money.
    const merchantAccount = await this.merchant
      .account()
      .catch((e: unknown) => {
        if (e instanceof MoneyError && e.code === 'provider_unreachable') {
          throw new MoneyError(
            'provider_unreachable',
            'Payments are not available right now. Your points are safe. Try again in a moment.',
            { retryAfterSeconds: this.provider.timings.retryAfterSeconds },
          );
        }
        throw e;
      });

    const id = randomUUID();
    const data: Prisma.PointConversionUncheckedCreateInput = {
      id,
      wawuUserId: input.wawuUserId,
      points: input.points,
      cashKobo: input.cashKobo,
      per1000PointsKobo: BigInt(input.per1000PointsKobo),
      merchantAccountNumber: merchantAccount,
      provider: this.provider.name,
      customerReference: conversionReference(id),
    };
    // The conversion, its key's link and the hold of its points, together:
    // there is no conversion without held points and no held points without a
    // conversion. The hold is last, so the person's points lock is taken after
    // everything else and let go at once. `insufficient_points` rolls it all
    // back, and the filter then gives the key back (it names nothing yet).
    await this.prisma.$transaction(async (tx) => {
      await this.keys.attach(tx, input.scope, id);
      await tx.pointConversion.create({ data });
      await this.points.hold(
        {
          wawuUserId: input.wawuUserId,
          purpose: 'cash_out',
          reference: id,
          points: input.points,
          title: CASH_OUT_HOLD_TITLE,
        },
        { tx },
      );
    });

    const result = await this.drive(id);
    const view = this.view(await this.load(result.conversionId));
    await this.keys.finish(input.scope, 201, conversionBody(view));
    return view;
  }

  /** One conversion as it stands now, for the person it belongs to; our records only. */
  async read(wawuUserId: string, id: string): Promise<PointsConversionView> {
    const c = await this.prisma.pointConversion.findFirst({
      where: { id, wawuUserId },
    });
    if (!c) throw new MoneyError('not_found', 'We could not find that.');
    return this.view(c);
  }

  /**
   * What is in flight now, for the nightly check (MONEY-16): the conversions
   * still `held` of the provider this server runs, counted and summed in
   * kobo. The cash of one that was handed to the provider may already have
   * left WAWU's account without our record knowing yet. Never shown as a
   * balance.
   */
  async inFlightTotals(): Promise<{ count: number; amountKobo: bigint }> {
    const rows = await this.prisma.pointConversion.aggregate({
      where: { status: 'held', provider: this.provider.name },
      _count: { _all: true },
      _sum: { cashKobo: true },
    });
    return { count: rows._count._all, amountKobo: rows._sum.cashKobo ?? 0n };
  }

  view(c: ConversionRow): PointsConversionView {
    const status = c.status as ConversionStatus;
    const shown: PointsConversionStatus =
      status === 'paid'
        ? 'completed'
        : status === 'cancelled'
          ? 'failed'
          : 'pending';
    return {
      id: c.id,
      status: shown,
      currency: 'NGN',
      points: c.points,
      cashKobo: koboNumber(c.cashKobo),
      reference: c.customerReference,
      statusMessage:
        shown === 'pending'
          ? c.reviewSince
            ? CONVERSION_WORDS.review
            : CONVERSION_WORDS.pending
          : null,
      failureReason: shown === 'failed' ? c.failureReason : null,
      createdAt: c.createdAt.toISOString(),
      completedAt: c.settledAt ? c.settledAt.toISOString() : null,
    };
  }

  // -------------------------------------------------------------------------
  // The sweep
  // -------------------------------------------------------------------------

  /**
   * Every minute: every conversion still held, not under review, due, and
   * older than CONVERSION_SWEEP_GRACE_MS (the request that made it is driving
   * it until then), of the provider this server runs, is driven a step. That
   * finishes what a request that died after it made the conversion never
   * sent, and asks the provider about every move whose answer was lost.
   *
   * The pass walks EVERY due conversion by a keyset cursor (creation time,
   * then id), with no cap on the rows it looks at, the way the hold sweep
   * does (MONEY-18 round 2, F4). It stops only at the end of the due
   * conversions or when its time is used (`budgetMs`), and the next pass
   * starts where this one stopped. The counts are for logs and tests:
   * `paid` conversions that were paid when this pass looked at them (another
   * process may have paid one in the same minute, and both count it; the
   * cash moved once either way).
   */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'points-cash-out-settle' })
  async sweep(
    now = new Date(),
    opts: { budgetMs?: number } = {},
  ): Promise<{ checked: number; paid: number }> {
    const counts = { checked: 0, paid: 0 };
    if (this.sweeping) return counts;
    this.sweeping = true;
    const budgetMs = opts.budgetMs ?? CONVERSION_SWEEP_BUDGET_MS;
    const started = Date.now();
    try {
      let after: ConversionSweepCursor | null = this.sweepAfter;
      for (;;) {
        const where: Prisma.PointConversionWhereInput = {
          status: 'held',
          reviewSince: null,
          provider: this.provider.name,
          createdAt: {
            lte: new Date(now.getTime() - CONVERSION_SWEEP_GRACE_MS),
          },
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
        };
        const due = await this.prisma.pointConversion.findMany({
          where,
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: CONVERSION_SWEEP_PAGE,
          select: { id: true, createdAt: true },
        });
        for (const { id, createdAt } of due) {
          counts.checked += 1;
          try {
            const r = await this.drive(id, now);
            if (r.state === 'paid') counts.paid += 1;
          } catch (e) {
            this.logger.error(
              `conversion ${id}: the sweep could not drive it (${e instanceof Error ? e.name : 'error'})`,
            );
          }
          // Out of time (a slow provider spends it a conversion at a time):
          // the next pass starts after this one.
          if (Date.now() - started >= budgetMs) {
            this.sweepAfter = { at: createdAt, id };
            return counts;
          }
        }
        if (due.length < CONVERSION_SWEEP_PAGE) {
          // Read to the end: the next pass starts from the front again.
          this.sweepAfter = null;
          break;
        }
        const last = due[due.length - 1];
        after = { at: last.createdAt, id: last.id };
      }
    } catch (e) {
      this.logger.error(
        `conversion sweep failed: ${e instanceof Error ? e.message : 'unknown'}`,
      );
    } finally {
      this.sweeping = false;
    }
    return counts;
  }

  /**
   * Moves a conversion one step: asks the provider about a move that was
   * handed over, or hands it over. Never sends a move whose outcome is
   * unknown.
   */
  async drive(id: string, now = new Date()): Promise<ConversionResult> {
    const c = await this.load(id);
    if (c.status !== 'held') return this.resultOf(c);
    if (c.reviewSince) return this.resultOf(c);
    // Not yet due: a lease on a call in flight, or a back-off.
    if (c.nextAttemptAt && c.nextAttemptAt.getTime() > now.getTime()) {
      return this.resultOf(c);
    }
    if (!isRowOf(this.provider.name, c.provider)) {
      // Another provider's conversion (made before a switch of
      // WALLET_PROVIDER): this one's silence says nothing and it sends
      // nothing. It waits for its own provider.
      return this.resultOf(c);
    }
    return c.sentAt ? this.reconcile(c, now) : this.send(c, now);
  }

  private load(id: string): Promise<ConversionRow> {
    return this.prisma.pointConversion.findUniqueOrThrow({ where: { id } });
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  private async send(c: ConversionRow, now: Date): Promise<ConversionResult> {
    const cap = this.fees.providerFees.merchantMaxPerTxnKobo;
    if (cap !== null && c.cashKobo > BigInt(cap)) {
      // Refuse, never split (WALLET.md, lead ruling 1): a person decides.
      return this.toReview(
        c,
        `the conversion of ${c.cashKobo} kobo is above the cap of ${cap} kobo on one move through WAWU's account`,
      );
    }
    if (!c.wawuUserId) {
      // The account was deleted before anything was sent: nothing is owed.
      return this.cancel(c, 'no_wallet', 'the account was deleted');
    }
    const wallet = await this.prisma.fintavaWallet.findUnique({
      where: { wawuUserId: c.wawuUserId },
      select: { accountNumber: true, provider: true },
    });
    if (!wallet || !isRowOf(this.provider.name, wallet.provider)) {
      // Nowhere to pay into, and nothing sent: the points go back.
      return this.cancel(
        c,
        'no_wallet',
        'the person has no wallet of the running provider',
      );
    }
    if (
      await this.isWawuAccount(c.merchantAccountNumber, wallet.accountNumber)
    ) {
      return this.toReview(
        c,
        "the conversion would move money from WAWU's account to WAWU's account",
      );
    }

    // The lease: only the caller that wins it hands the move to the provider.
    // `sentAt` set means a record may exist at the provider from here on. A
    // conditional update on the conversion's own row is what makes one caller
    // win between servers.
    const leaseUntil = new Date(
      now.getTime() +
        this.provider.timings.moneyTimeoutMs +
        this.provider.timings.resendSafetyMs,
    );
    const { count } = await this.prisma.pointConversion.updateMany({
      where: {
        id: c.id,
        status: 'held',
        reviewSince: null,
        sentAt: null,
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      data: {
        sentAt: now,
        nextAttemptAt: leaseUntil,
        attempts: { increment: 1 },
        destinationAccountNumber: wallet.accountNumber,
      },
    });
    if (count === 0) return this.resultOf(await this.load(c.id));

    let receipt: ProviderTransferReceipt;
    try {
      receipt = await this.provider.walletToWallet({
        fromAccountNumber: c.merchantAccountNumber,
        toAccountNumber: wallet.accountNumber,
        amountKobo: c.cashKobo,
        reference: c.customerReference,
        narration: CASH_OUT_NARRATION,
      });
    } catch (e) {
      return this.afterRefusal(c, e, now);
    }
    return this.afterReceipt(
      { ...c, destinationAccountNumber: wallet.accountNumber },
      receipt,
    );
  }

  /**
   * Whether the destination is WAWU's own account at the provider, however
   * the provider names it (the seam's `isSameAccount`, when it has one).
   */
  private async isWawuAccount(
    merchant: string,
    destination: string,
  ): Promise<boolean> {
    if (merchant === destination) return true;
    if (!this.provider.isSameAccount) return false;
    try {
      return await this.provider.isSameAccount(destination, merchant);
    } catch {
      // It cannot say: the sender and the receiver are both read from our
      // own records, so the move is not stopped on a silent answer.
      return false;
    }
  }

  /** The provider did not take the move, or we do not know whether it did. */
  private async afterRefusal(
    c: ConversionRow,
    e: unknown,
    now: Date,
  ): Promise<ConversionResult> {
    if (!provedNothingMoved(e)) {
      // Money may have moved (a lost answer, a transfer accepted and not
      // finished, a repeated reference): asked about, never sent again, the
      // points still held. A request that PROVABLY never reached the provider
      // (`requestNotSent`) is not here: nothing was sent.
      this.logger.warn(
        `conversion ${c.id}: the outcome is unknown (${e instanceof WalletProviderError ? e.kind : 'error'}); asking ${this.provider.label} about it`,
      );
      await this.schedule(c, now, 1);
      return this.resultOf(await this.load(c.id));
    }
    // Proved: nothing moved and no record exists. The points go back.
    if (e.requestNotSent) {
      this.logger.warn(
        `conversion ${c.id}: ${this.provider.label} could not be reached (the request was not sent); the points are given back`,
      );
    } else if (e.kind === 'insufficient_funds') {
      this.logger.error(
        `conversion ${c.id}: ${this.provider.label} says WAWU's own account cannot cover ${c.cashKobo} kobo; the points are given back`,
      );
    } else {
      this.logger.error(
        `conversion ${c.id}: ${this.provider.label} refused the move (${e.kind}); nothing moved and the points are given back`,
      );
    }
    return this.cancel(
      c,
      'refused',
      `${this.provider.label} refused (${e.kind})`,
    );
  }

  /** The provider confirmed the move in its answer. */
  private async afterReceipt(
    c: ConversionRow,
    receipt: ProviderTransferReceipt,
  ): Promise<ConversionResult> {
    if (receipt.amountKobo !== c.cashKobo) {
      // It moved another amount than asked: a stop. The ledger is not
      // written with a figure we did not ask for; a person looks, with the
      // points still held.
      return this.toReview(
        c,
        `${this.provider.label} moved ${receipt.amountKobo} kobo for a conversion of ${c.cashKobo} kobo`,
      );
    }
    return this.land(c, {
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

  private async reconcile(
    c: ConversionRow,
    now: Date,
  ): Promise<ConversionResult> {
    let answer: ProviderReconciliation | null = null;
    try {
      answer = await this.provider.reconcileSend(
        c.customerReference,
        { kind: 'merchant' },
        c.sentAt ?? c.createdAt,
      );
    } catch (e) {
      this.logger.warn(
        `conversion ${c.id}: ${this.provider.label} could not be asked (${e instanceof WalletProviderError ? e.kind : 'error'})`,
      );
    }
    if (answer?.state === 'found') {
      const t = answer.transaction;
      if (t.outcome === 'completed') {
        if (t.amountKobo !== c.cashKobo) {
          return this.toReview(
            c,
            `${this.provider.label} moved ${t.amountKobo} kobo for a conversion of ${c.cashKobo} kobo`,
          );
        }
        const tagapay =
          t.secondaryReference ??
          (await this.provider.secondaryReferenceOf(t).catch(() => null));
        return this.land(c, {
          // Fintava's lookups carry no charge; Nuvion's record does.
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
        // The provider's own record: the move did not happen and the money is
        // where it was. Only this (or a refusal that proved it) gives the
        // points back.
        this.logger.warn(
          `conversion ${c.id}: ${this.provider.label} says the move failed; the points are given back`,
        );
        return this.cancel(
          c,
          'failed',
          `${this.provider.label} says the move failed`,
        );
      }
      if (t.outcome === 'reversed') {
        return this.toReview(
          c,
          `${this.provider.label} moved the cash and then reversed it; WAWU's account holds the money again`,
        );
      }
      // Pending, or a word we do not know: neither says no money moved.
    }
    return this.stillUnknown(c, now);
  }

  /** Still unknown: asked again later, or sent to a person past the bound. */
  private async stillUnknown(
    c: ConversionRow,
    now: Date,
  ): Promise<ConversionResult> {
    const since = (c.sentAt ?? c.createdAt).getTime();
    if (now.getTime() - since >= this.settings.reviewAfterHours * 3_600_000) {
      return this.toReview(
        c,
        `no answer from ${this.provider.label} about the move after ${this.settings.reviewAfterHours} hours; it may have moved`,
      );
    }
    await this.schedule(c, now, c.checks + 1);
    return this.resultOf(await this.load(c.id));
  }

  /** The next question to the provider, with the rest doubling each time. */
  private async schedule(
    c: ConversionRow,
    now: Date,
    checks: number,
  ): Promise<void> {
    await this.prisma.pointConversion.updateMany({
      where: { id: c.id, status: 'held' },
      data: {
        checks: { increment: 1 },
        nextAttemptAt: new Date(now.getTime() + restMs(checks)),
      },
    });
  }

  // -------------------------------------------------------------------------
  // Landing and cancelling: the conversion and its points, in one transaction
  // -------------------------------------------------------------------------

  /**
   * The provider confirmed the cash: the ledger gets both sides, then the
   * conversion becomes `paid` and its hold is committed, in ONE transaction
   * (the conversion's row first, the points last), so the two never disagree.
   * A conversion another caller already paid changes nothing here.
   */
  private async land(
    c: ConversionRow,
    fig: {
      feeKobo: bigint | null;
      refs: {
        fintavaReference?: string | null;
        tagapayTransRef?: string | null;
        fintavaTransactionId?: string | null;
      };
      occurredAt: Date | null;
    },
  ): Promise<ConversionResult> {
    // A negative charge is nothing a provider charges: the move stands, the
    // charge is not recorded as a figure, and the conversion says why.
    const fee = fig.feeKobo !== null && fig.feeKobo >= 0n ? fig.feeKobo : null;
    await this.writeLedger(c, fee, fig.refs, fig.occurredAt);
    const now = new Date();
    try {
      await this.prisma.$transaction(async (tx) => {
        const { count } = await tx.pointConversion.updateMany({
          where: { id: c.id, status: 'held' },
          data: {
            status: 'paid',
            settledAt: now,
            providerFeeKobo: fee,
            nextAttemptAt: null,
            ...(fig.feeKobo !== null && fee === null
              ? {
                  discrepancy: joinNotes(
                    c.discrepancy,
                    `${this.provider.label} reported a charge of ${fig.feeKobo} kobo on the move`,
                  ),
                }
              : {}),
          },
        });
        // Another caller paid it first: its transaction committed the hold.
        if (count !== 1) return;
        await this.settleHold(tx, c.id, 'commit');
      });
    } catch (e) {
      if (e instanceof PointsError && e.code === 'points_hold_settled') {
        // The cash is confirmed and the points were already given back: a
        // person decides. Nothing is changed.
        return this.toReview(
          c,
          `${this.provider.label} confirmed the cash but its points were already given back`,
        );
      }
      throw e;
    }
    return this.resultOf(await this.load(c.id));
  }

  /**
   * The cash did not move (the provider said so, or its own record did):
   * the conversion becomes `cancelled` and its hold is released, in ONE
   * transaction, so the points come back to the lots they came from exactly
   * when the conversion says they did. A conversion another caller already
   * settled changes nothing here.
   */
  private async cancel(
    c: ConversionRow,
    reason: CancelReason,
    note: string,
  ): Promise<ConversionResult> {
    const now = new Date();
    try {
      await this.prisma.$transaction(async (tx) => {
        const { count } = await tx.pointConversion.updateMany({
          where: { id: c.id, status: 'held' },
          data: {
            status: 'cancelled',
            settledAt: now,
            failureReason: CONVERSION_WORDS.cancelled[reason],
            nextAttemptAt: null,
            discrepancy: joinNotes(c.discrepancy, `cancelled: ${note}`),
          },
        });
        if (count !== 1) return;
        await this.settleHold(tx, c.id, 'release');
      });
    } catch (e) {
      if (e instanceof PointsError && e.code === 'points_hold_settled') {
        return this.toReview(
          c,
          'the conversion was to be cancelled but its points were already spent',
        );
      }
      throw e;
    }
    return this.resultOf(await this.load(c.id));
  }

  /**
   * Commits or releases the conversion's hold inside the caller's
   * transaction. A hold that is gone was deleted with the person's points
   * (the account purge): there is nothing to settle then.
   */
  private async settleHold(
    tx: Prisma.TransactionClient,
    conversionId: string,
    how: 'commit' | 'release',
  ): Promise<void> {
    const key = { purpose: 'cash_out' as const, reference: conversionId };
    try {
      if (how === 'commit') await this.points.commit(key, { tx });
      else await this.points.release(key, { tx });
    } catch (e) {
      if (e instanceof PointsError && e.code === 'points_hold_not_found') {
        this.logger.warn(
          `conversion ${conversionId}: its points hold is gone (the account was deleted); nothing to ${how}`,
        );
        return;
      }
      throw e;
    }
  }

  /**
   * Both sides of the move in the ledger: WAWU's account (money out) and the
   * person's wallet (money in), under our reference, linked to the
   * conversion with the kind `points_cash_out`. Best effort, like every
   * ledger write after the money moved: the signed delivery and the status
   * check write them too, and the conversion's own state is the provider's
   * record.
   */
  private async writeLedger(
    c: ConversionRow,
    fee: bigint | null,
    refs: {
      fintavaReference?: string | null;
      tagapayTransRef?: string | null;
      fintavaTransactionId?: string | null;
    },
    occurredAt: Date | null,
  ): Promise<void> {
    const dest = c.destinationAccountNumber;
    if (!dest || !c.wawuUserId) return;
    const amount = koboNumber(c.cashKobo);
    const link = {
      kind: 'points_cash_out' as const,
      targetId: c.id,
      title: `${c.points.toLocaleString('en-NG')} ${POINTS_WORD}`,
    };
    const common = {
      status: 'completed' as const,
      category: 'earning' as const,
      link,
      narration: CASH_OUT_NARRATION,
      references: { customerReference: c.customerReference, ...refs },
      // Our own move, known to us: the category, link and counterparty are
      // ours to set, however the ledger first heard of it.
      source: 'send' as const,
      ...(occurredAt ? { occurredAt } : {}),
    };
    // What the provider took from WAWU's account on top (R-31). A record that
    // carries no charge (Fintava's lookups) leaves the figures the row holds
    // standing; the schedule's charge only creates a row that is not there.
    const expected = this.expectedFeeKobo(c.cashKobo);
    const takenFee = fee ?? expected ?? 0n;
    const out: LedgerMovementInput = {
      ...common,
      wallet: { kind: 'merchant', accountNumber: c.merchantAccountNumber },
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
        wawuUserId: c.wawuUserId,
        accountNumber: dest,
      },
    };
    const inn: LedgerMovementInput = {
      ...common,
      wallet: { kind: 'user', wawuUserId: c.wawuUserId, accountNumber: dest },
      direction: 'in',
      amountKobo: amount,
      feeKobo: 0,
      totalKobo: amount,
      // The cash comes from WAWU: no other person is on the row.
      counterparty: { kind: 'wawu', name: null },
    };
    for (const movement of [out, inn]) {
      try {
        await this.ledger.record(movement, undefined, { quiet: true });
      } catch (e) {
        this.logger.error(
          `conversion ${c.id}: the ledger could not record the move (${e instanceof Error ? e.name : 'error'})`,
        );
      }
    }
  }

  /** The schedule's charge on a move, or null when fees are not set. */
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
  // Review
  // -------------------------------------------------------------------------

  /**
   * Out of the sweep, for a person to look at. The money stays where it is
   * and the points stay held: nothing is released on a guess.
   */
  private async toReview(
    c: ConversionRow,
    note: string,
  ): Promise<ConversionResult> {
    const { count } = await this.prisma.pointConversion.updateMany({
      where: { id: c.id, status: 'held', reviewSince: null },
      data: {
        reviewSince: new Date(),
        nextAttemptAt: null,
        discrepancy: joinNotes(c.discrepancy, note),
      },
    });
    if (count > 0) {
      this.logger.error(`conversion ${c.id}: ${note}; sent to review`);
    }
    return this.resultOf(await this.load(c.id));
  }

  // -------------------------------------------------------------------------
  // What the caller is told
  // -------------------------------------------------------------------------

  private resultOf(c: ConversionRow): ConversionResult {
    let state: ConversionState;
    if (c.status === 'paid') state = 'paid';
    else if (c.status === 'cancelled') state = 'cancelled';
    else if (c.reviewSince) state = 'review';
    else state = 'pending';
    return {
      conversionId: c.id,
      state,
      status: c.status as ConversionStatus,
    };
  }
}
