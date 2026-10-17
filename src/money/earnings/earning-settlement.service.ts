import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { isRowOf } from '../../wallet-provider/provider-rows';
import {
  type ProviderReconciliation,
  type ProviderTransferReceipt,
  safeKoboNumber,
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import { WalletProviderError } from '../../wallet-provider/wallet-provider-error';
import type { PaymentKind } from '../dto/money-enums';
import { FeeQuoteService } from '../fees/fee-quote.service';
import { WALLET_WAITS, walletWaitRestMs } from '../holds/hold-rules';
import type { LedgerMovementInput } from '../ledger/ledger.interface';
import { koboNumber, LedgerService } from '../ledger/ledger.service';
import { PaymentSettings } from '../payments/payment-config';
import { joinNotes } from '../payments/payment-figures';
import {
  EARNING_ADOPT_MAX_PAGES,
  EARNING_ADOPT_PAGE,
  EARNING_NARRATION,
  EARNING_SWEEP_BUDGET_MS,
  EARNING_SWEEP_PAGE,
  type EarningSettlementResult,
  type EarningSettlementState,
  type EarningStatus,
  type EarningSweepCursor,
  type EarningWaiting,
  earningReference,
  NOT_SETTLED_HERE,
  waitingAfterRefusal,
} from './earning-rules';

type SettlementRow = Prisma.EarningSettlementGetPayload<object>;

const MINUTE = 60_000;

/** The rest before the next try or question: 1, 2, 4 ... minutes, at most an hour. */
function restMs(count: number): number {
  return Math.min(60, 2 ** Math.min(Math.max(count, 0), 6)) * MINUTE;
}

/**
 * A sale's 85% lands in the payee's wallet (task WALLET-16, R-11).
 *
 * An ordinary sale (an unlock, a tip, a legal fee, school fees: any kind that
 * is not held) is paid into WAWU's own account at the wallet provider
 * (MONEY-17). Nothing asks for the payee's share: when the sale is finished
 * (completed, delivered, not in review) the sweep makes one `EarningSettlement`
 * for it, and the payee's 85% (R-5) moves from WAWU's account into the payee's
 * wallet. The 15% is WAWU's and stays. A held kind (a paid DM, a ticket, a
 * bill) never comes here: its share lands when the owning feature releases
 * the hold (MONEY-18), and the database refuses a settlement for it.
 *
 * The provider's charge on the move is WAWU's, paid from its 15% (R-31): the
 * payee receives the whole share.
 *
 * **Once.** One sale, one settlement (the payment id is unique) and one
 * reference at the provider (`wawu-earn-<payment id>`), so asking again, from
 * the sweep, a second Hub process or after a restart, never moves it twice.
 * The move is handed over by a lease (`sentAt`) only one caller wins.
 *
 * **The provider's record is the truth.** The earning is `landed` only when
 * the provider confirmed the move, from its answer to the send, or from its
 * record of our reference when the answer was lost. A move whose outcome is
 * unknown (a timeout, a 5xx, a transfer accepted and not finished, a repeated
 * reference, a Hub killed between the provider's answer and our write) is
 * asked about, backing off to hourly, and is never sent again and never read
 * as "nothing moved"; past PAYMENT_REVIEW_AFTER_HOURS it goes to a person.
 * Only the provider's own record that the move failed starts a new try, under
 * a new reference. A balance is never added up from earnings: the provider's
 * is the only one.
 *
 * **Waiting is not failing.** A person with no wallet yet (R-11: they keep
 * earning and the money lands within a minute of the wallet opening), a frozen
 * wallet (BACKEND_GAPS G-10), WAWU's own account short of money, the provider
 * out of reach or without the move yet (`not_supported`): the earning stays
 * owed, the money stays in WAWU's account, and the sweep tries again.
 *
 * Through the provider seam only (MONEY-20): a server acts only on sales of
 * the provider it runs.
 */
@Injectable()
export class EarningSettlementService {
  private readonly logger = new Logger(EarningSettlementService.name);
  private sweeping = false;
  /** Where the last pass stopped when its time ran out; null once it has read to the end. */
  private sweepAfter: EarningSweepCursor | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(WALLET_PROVIDER) private readonly provider: WalletProvider,
    private readonly ledger: LedgerService,
    private readonly fees: FeeQuoteService,
    private readonly settings: PaymentSettings,
  ) {}

  /**
   * What is owed now, for the nightly check (MONEY-16): the earnings still
   * `owed` of the provider this server runs, counted and summed in kobo. The
   * money is in WAWU's own account until the provider confirms the move, so
   * it is part of what that account holds. Compared with the provider's own
   * balance by MONEY-16, never shown as a balance.
   */
  async owedTotals(): Promise<{ count: number; amountKobo: bigint }> {
    const rows = await this.prisma.earningSettlement.aggregate({
      where: { status: 'owed', provider: this.provider.name },
      _count: { _all: true },
      _sum: { amountKobo: true },
    });
    return {
      count: rows._count._all,
      amountKobo: rows._sum.amountKobo ?? 0n,
    };
  }

  /** The settlement of a payment, or null when it has none. */
  async forPayment(paymentId: string): Promise<EarningSettlementResult | null> {
    const row = await this.prisma.earningSettlement.findUnique({
      where: { paymentId },
    });
    return row ? this.resultOf(row) : null;
  }

  // -------------------------------------------------------------------------
  // The sweep
  // -------------------------------------------------------------------------

  /**
   * Every minute: first every finished ordinary sale that has no earning yet
   * becomes one (`adopt`), then every earning that is owed, not under review
   * and due, of the provider this server runs, is driven a step.
   *
   * The pass walks EVERY due earning by a keyset cursor (creation time, then
   * id), with no cap on the rows it looks at, the way the hold sweep does
   * (MONEY-18 round 2, F4). It stops only at the end of the due earnings or
   * when its time is used (`budgetMs`), and the next pass starts where this
   * one stopped, so no number of earnings in front can keep it from the ones
   * behind. An earning waiting for a person's wallet rests (a minute to an
   * hour, by its age) instead of being due on every pass, and is woken the
   * moment its person has a wallet (R-11).
   *
   * The counts are for logs and tests: `adopted` earnings made, `checked`
   * earnings looked at, `landed` earnings that were landed when this pass
   * looked at them (another process may have landed one in the same minute,
   * and both count it; the sale is landed once either way).
   */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'money-earning-settle' })
  async sweep(
    now = new Date(),
    opts: { budgetMs?: number } = {},
  ): Promise<{ adopted: number; checked: number; landed: number }> {
    const counts = { adopted: 0, checked: 0, landed: 0 };
    if (this.sweeping) return counts;
    this.sweeping = true;
    const budgetMs = opts.budgetMs ?? EARNING_SWEEP_BUDGET_MS;
    const started = Date.now();
    try {
      counts.adopted = await this.adopt();
      await this.wakeWalletWaiters(now);
      let after: EarningSweepCursor | null = this.sweepAfter;
      for (;;) {
        const where: Prisma.EarningSettlementWhereInput = {
          status: 'owed',
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
        };
        const due = await this.prisma.earningSettlement.findMany({
          where,
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: EARNING_SWEEP_PAGE,
          select: { id: true, createdAt: true },
        });
        for (const { id, createdAt } of due) {
          counts.checked += 1;
          try {
            const s = await this.drive(id, now);
            if (s.state === 'landed') counts.landed += 1;
          } catch (e) {
            this.logger.error(
              `earning ${id}: the sweep could not drive it (${e instanceof Error ? e.name : 'error'})`,
            );
          }
          // Out of time (a slow provider spends it an earning at a time):
          // the next pass starts after this one.
          if (Date.now() - started >= budgetMs) {
            this.sweepAfter = { at: createdAt, id };
            return counts;
          }
        }
        if (due.length < EARNING_SWEEP_PAGE) {
          // Read to the end: the next pass starts from the front again.
          this.sweepAfter = null;
          break;
        }
        const last = due[due.length - 1];
        after = { at: last.createdAt, id: last.id };
      }
    } catch (e) {
      this.logger.error(
        `earning sweep failed: ${e instanceof Error ? e.message : 'unknown'}`,
      );
    } finally {
      this.sweeping = false;
    }
    return counts;
  }

  /**
   * Makes the settlement of every finished ordinary sale of the running
   * provider that has none. Finished is exact: the payment is `completed`,
   * what was paid for is delivered or has nothing to deliver (`openKey` is
   * given up, MONEY-17 R2-1), and no review mark is on it (a delivery or a
   * charge in question waits for a person, and its earning with it). A held
   * kind is never taken (its share lands by the hold's release), nor a payment
   * that has a hold, nor one with no payee, nor a share under a kobo.
   *
   * Idempotent and safe between servers: the payment id is unique, so two
   * passes making the same row make one. A batch the database refuses (a
   * payment that changed under it) is made one by one so a single sale cannot
   * keep the others from being taken.
   */
  private async adopt(): Promise<number> {
    let made = 0;
    // Sales the database refused in this pass: left out of the next pages, so
    // one sale cannot keep the others from being taken.
    const refused: string[] = [];
    for (let page = 0; page < EARNING_ADOPT_MAX_PAGES; page += 1) {
      const sales = await this.prisma.walletPayment.findMany({
        where: {
          id: { notIn: refused },
          status: 'completed',
          completedAt: { not: null },
          payeeWawuUserId: { not: null },
          payeeShareKobo: { gt: 0n },
          payeeSettledAt: null,
          openKey: null,
          reviewSince: null,
          chargeReviewSince: null,
          provider: this.provider.name,
          kind: { notIn: [...NOT_SETTLED_HERE] },
          hold: { is: null },
          earning: { is: null },
        },
        orderBy: [{ completedAt: 'asc' }, { id: 'asc' }],
        take: EARNING_ADOPT_PAGE,
      });
      if (sales.length === 0) break;
      const rows = sales.map((p) => ({
        paymentId: p.id,
        payeeWawuUserId: p.payeeWawuUserId!,
        kind: p.kind,
        targetId: p.targetId,
        title: p.title,
        earnedAt: p.completedAt!,
        amountKobo: p.payeeShareKobo,
        merchantAccountNumber: p.merchantAccountNumber,
        provider: p.provider,
        customerReference: earningReference(p.id, 1),
      }));
      try {
        const { count } = await this.prisma.earningSettlement.createMany({
          data: rows,
          skipDuplicates: true,
        });
        made += count;
      } catch {
        for (const row of rows) {
          try {
            const { count } = await this.prisma.earningSettlement.createMany({
              data: [row],
              skipDuplicates: true,
            });
            made += count;
          } catch (e) {
            refused.push(row.paymentId);
            this.logger.error(
              `payment ${row.paymentId}: its earning could not be made (${e instanceof Error ? e.name : 'error'}); a person looks`,
            );
          }
        }
      }
      if (sales.length < EARNING_ADOPT_PAGE) break;
    }
    return made;
  }

  /**
   * An earning that waits for a person's wallet rests until its next look;
   * one whose person has a wallet NOW is made due at once, so the money lands
   * in the first sweep after the wallet opens (R-11) however long it had
   * rested. Only the running provider's wallets count (a wallet of the other
   * provider is not a place this server can send to).
   */
  private async wakeWalletWaiters(now: Date): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        UPDATE "EarningSettlement" s
           SET "nextAttemptAt" = NULL
         WHERE s."status" = 'owed'
           AND s."reviewSince" IS NULL AND s."sentAt" IS NULL
           AND s."provider" = ${this.provider.name}
           AND s."waiting" = 'payee_wallet'
           AND s."nextAttemptAt" > ${now}
           AND EXISTS (
             SELECT 1 FROM "FintavaWallet" w
              WHERE w."wawuUserId" = s."payeeWawuUserId"
                AND LOWER(BTRIM(COALESCE(w."provider", 'fintava'))) = ${this.provider.name})`;
    } catch (e) {
      // The waiters keep their rest and are looked at when it ends.
      this.logger.error(
        `earning sweep: could not wake the earnings waiting for a wallet (${e instanceof Error ? e.name : 'error'})`,
      );
    }
  }

  /**
   * Moves an earning one step: asks the provider about a move that was handed
   * over, or hands it over. Never sends a move whose outcome is unknown.
   */
  async drive(
    settlementId: string,
    now = new Date(),
  ): Promise<EarningSettlementResult> {
    const s = await this.load(settlementId);
    if (s.status !== 'owed') return this.resultOf(s);
    if (s.reviewSince) return this.resultOf(s);
    // Not yet due: a lease on a call in flight, or a back-off.
    if (s.nextAttemptAt && s.nextAttemptAt.getTime() > now.getTime()) {
      return this.resultOf(s);
    }
    if (!isRowOf(this.provider.name, s.provider)) {
      // Another provider took this sale (written before a switch of
      // WALLET_PROVIDER): this one's silence says nothing and it sends
      // nothing. It waits for its own provider.
      return this.waitFor(s, 'provider', now, true);
    }
    return s.sentAt ? this.reconcile(s, now) : this.send(s, now);
  }

  private load(id: string): Promise<SettlementRow> {
    return this.prisma.earningSettlement.findUniqueOrThrow({ where: { id } });
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  private async send(
    s: SettlementRow,
    now: Date,
  ): Promise<EarningSettlementResult> {
    const amount = s.amountKobo;
    const cap = this.fees.providerFees.merchantMaxPerTxnKobo;
    if (cap !== null && amount > BigInt(cap)) {
      // Refuse, never split (WALLET.md, lead ruling 1): a person decides.
      return this.toReview(
        s,
        `the earning of ${amount} kobo is above the cap of ${cap} kobo on one move through WAWU's account`,
      );
    }

    const wallet = await this.prisma.fintavaWallet.findUnique({
      where: { wawuUserId: s.payeeWawuUserId },
      select: { accountNumber: true, provider: true },
    });
    if (!wallet || !isRowOf(this.provider.name, wallet.provider)) {
      // R-11: a creator without a wallet keeps earning; the money waits.
      return this.waitFor(s, 'payee_wallet', now);
    }
    if (
      await this.isWawuAccount(s.merchantAccountNumber, wallet.accountNumber)
    ) {
      return this.toReview(
        s,
        "the earning would move money from WAWU's account to WAWU's account",
      );
    }

    // The lease: only the caller that wins it hands the move to the provider.
    // `sentAt` set means a record may exist at the provider from here on. The
    // sale must still be a finished one at this moment: the lease is taken
    // with the sale's row read FOR SHARE, so a review mark set since the
    // earning was made either is seen here (nothing is sent) or waits for
    // the lease to commit. A conditional update on the earning's own row is
    // what makes one caller win between servers.
    const leaseUntil = new Date(
      now.getTime() +
        this.provider.timings.moneyTimeoutMs +
        this.provider.timings.resendSafetyMs,
    );
    const leased = await this.prisma.$transaction(async (tx) => {
      const finished = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "WalletPayment"
         WHERE "id" = ${s.paymentId}
           AND "status" = 'completed'
           AND "reviewSince" IS NULL
           AND "chargeReviewSince" IS NULL
           FOR SHARE`;
      if (finished.length === 0) return 'not_finished' as const;
      const { count } = await tx.earningSettlement.updateMany({
        where: {
          id: s.id,
          status: 'owed',
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
      return count === 1 ? ('leased' as const) : ('lost' as const);
    });
    if (leased === 'not_finished') {
      // The sale is no longer a finished one: a person looks before anything
      // moves, and the earning waits for them.
      return this.toReview(
        s,
        'the sale is no longer a finished one (not completed, or under review); the earning waits for a person',
      );
    }
    if (leased === 'lost') return this.resultOf(await this.load(s.id));

    let receipt: ProviderTransferReceipt;
    try {
      receipt = await this.provider.walletToWallet({
        fromAccountNumber: s.merchantAccountNumber,
        toAccountNumber: wallet.accountNumber,
        amountKobo: amount,
        reference: s.customerReference,
        narration: EARNING_NARRATION,
      });
    } catch (e) {
      return this.afterRefusal(s, e, now);
    }
    return this.afterReceipt(
      { ...s, destinationAccountNumber: wallet.accountNumber },
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
    s: SettlementRow,
    e: unknown,
    now: Date,
  ): Promise<EarningSettlementResult> {
    const refusal = e instanceof WalletProviderError ? e : null;
    if (!refusal || (refusal.recordMayExist && !refusal.requestNotSent)) {
      // Money may have moved (a lost answer, a transfer accepted and not
      // finished, a repeated reference): asked about, never sent again. A
      // request that PROVABLY never reached the provider (a refused
      // connection, a host name that did not resolve: `requestNotSent`) is
      // not here: nothing was sent, so it is the refusal below.
      this.logger.warn(
        `earning ${s.id}: the outcome is unknown (${refusal?.kind ?? 'error'}); asking ${this.provider.label} about it`,
      );
      await this.schedule(s, now, 1);
      return this.resultOf(await this.load(s.id));
    }
    // A refusal that moved nothing: the lease is given back, the same
    // reference is used again (a refused send does not use it up).
    const { waiting, loud } = waitingAfterRefusal(refusal);
    if (refusal.requestNotSent) {
      this.logger.warn(
        `earning ${s.id}: ${this.provider.label} could not be reached (the request was not sent); it is tried again under the same reference`,
      );
    } else if (waiting === 'funds') {
      this.logger.error(
        `earning ${s.id}: ${this.provider.label} says WAWU's own account cannot cover the earning (${s.amountKobo} kobo): the sales' money is not where it should be`,
      );
    } else if (waiting === 'not_supported') {
      this.logger.error(
        `earning ${s.id}: ${this.provider.label} cannot make this move yet (not supported); the earning of ${s.amountKobo} kobo waits and lands when it can`,
      );
    } else if (loud) {
      this.logger.error(
        `earning ${s.id}: ${this.provider.label} refused the earning (${refusal.kind}); nothing moved`,
      );
    }
    await this.prisma.earningSettlement.updateMany({
      where: { id: s.id, status: 'owed', sentAt: { not: null } },
      data: {
        sentAt: null,
        waiting,
        nextAttemptAt: new Date(now.getTime() + restMs(s.attempts + 1)),
      },
    });
    // The review bound applies to a refusal with nothing moved (a person has
    // to look at why), CONVENTIONS section 26. The lease is already given
    // back above, so the earning goes to review with nothing handed over.
    if (waiting === 'refused' && this.refusedTooLong(s, now)) {
      return this.toReview(
        s,
        `the earning has been refused for ${this.settings.reviewAfterHours} hours`,
      );
    }
    return this.resultOf(await this.load(s.id));
  }

  /** Whether an earning has been refused for as long as the review bound, counted from the day it was made. */
  private refusedTooLong(s: SettlementRow, now: Date): boolean {
    return (
      now.getTime() - s.createdAt.getTime() >=
      this.settings.reviewAfterHours * 3_600_000
    );
  }

  /** The provider confirmed the move in its answer. */
  private async afterReceipt(
    s: SettlementRow,
    receipt: ProviderTransferReceipt,
  ): Promise<EarningSettlementResult> {
    if (receipt.amountKobo !== s.amountKobo) {
      // It moved another amount than asked: a stop. The ledger is not
      // written with a figure we did not ask for; a person looks.
      return this.toReview(
        s,
        `${this.provider.label} moved ${receipt.amountKobo} kobo for an earning of ${s.amountKobo} kobo`,
      );
    }
    return this.land(s, {
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
    s: SettlementRow,
    now: Date,
  ): Promise<EarningSettlementResult> {
    let answer: ProviderReconciliation | null = null;
    try {
      answer = await this.provider.reconcileSend(
        s.customerReference,
        { kind: 'merchant' },
        s.sentAt ?? s.createdAt,
      );
    } catch (e) {
      this.logger.warn(
        `earning ${s.id}: ${this.provider.label} could not be asked (${e instanceof WalletProviderError ? e.kind : 'error'})`,
      );
    }
    if (answer?.state === 'found') {
      const t = answer.transaction;
      if (t.outcome === 'completed') {
        if (t.amountKobo !== s.amountKobo) {
          return this.toReview(
            s,
            `${this.provider.label} moved ${t.amountKobo} kobo for an earning of ${s.amountKobo} kobo`,
          );
        }
        const tagapay =
          t.secondaryReference ??
          (await this.provider.secondaryReferenceOf(t).catch(() => null));
        return this.land(s, {
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
        // The provider's own record: the move did not happen and the money
        // is where it was. Only this starts a new try, under a new reference.
        return this.retryAfterFailure(s, now);
      }
      if (t.outcome === 'reversed') {
        return this.toReview(
          s,
          `${this.provider.label} moved the earning and then reversed it; WAWU's account holds the money again`,
        );
      }
      // Pending, or a word we do not know: neither says no money moved.
    }
    return this.stillUnknown(s, now);
  }

  /** Still unknown: asked again, or sent to a person past the bound. */
  private async stillUnknown(
    s: SettlementRow,
    now: Date,
  ): Promise<EarningSettlementResult> {
    const since = (s.sentAt ?? s.createdAt).getTime();
    if (now.getTime() - since >= this.settings.reviewAfterHours * 3_600_000) {
      return this.toReview(
        s,
        `no answer from ${this.provider.label} about the earning after ${this.settings.reviewAfterHours} hours; it may have moved`,
      );
    }
    await this.schedule(s, now, s.checks + 1);
    return this.resultOf(await this.load(s.id));
  }

  /** The next question to the provider, with the rest doubling each time. */
  private async schedule(
    s: SettlementRow,
    now: Date,
    checks: number,
  ): Promise<void> {
    await this.prisma.earningSettlement.updateMany({
      where: { id: s.id, status: 'owed' },
      data: {
        checks: { increment: 1 },
        nextAttemptAt: new Date(now.getTime() + restMs(checks)),
      },
    });
  }

  /** The provider's record says the move failed: a new try, a new reference. */
  private async retryAfterFailure(
    s: SettlementRow,
    now: Date,
  ): Promise<EarningSettlementResult> {
    const attempt = s.attempt + 1;
    this.logger.warn(
      `earning ${s.id}: ${this.provider.label} says the move failed; trying again as attempt ${attempt}`,
    );
    await this.prisma.earningSettlement.updateMany({
      where: {
        id: s.id,
        status: 'owed',
        sentAt: { not: null },
        customerReference: s.customerReference,
      },
      data: {
        attempt,
        customerReference: earningReference(s.paymentId, attempt),
        sentAt: null,
        checks: 0,
        waiting: 'refused',
        nextAttemptAt: new Date(now.getTime() + restMs(attempt)),
      },
    });
    return this.resultOf(await this.load(s.id));
  }

  // -------------------------------------------------------------------------
  // Landing
  // -------------------------------------------------------------------------

  /**
   * The provider confirmed the move: the ledger gets both sides, the earning
   * becomes `landed`, and the sale's payee share is marked paid, all in one
   * write so the two never disagree.
   */
  private async land(
    s: SettlementRow,
    fig: {
      feeKobo: bigint | null;
      refs: {
        fintavaReference?: string | null;
        tagapayTransRef?: string | null;
        fintavaTransactionId?: string | null;
      };
      occurredAt: Date | null;
    },
  ): Promise<EarningSettlementResult> {
    // A negative charge is nothing a provider charges: the move stands, the
    // charge is not recorded as a figure, and the earning says why.
    const fee = fig.feeKobo !== null && fig.feeKobo >= 0n ? fig.feeKobo : null;
    await this.writeLedger(s, fee, fig.refs, fig.occurredAt);
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      // The sale's row first, then the earning's, the order the lease takes
      // them in (it reads the sale FOR SHARE, then writes the earning), so the
      // two never wait on each other. Marking a sale that another caller
      // already marked changes nothing.
      await tx.walletPayment.updateMany({
        where: { id: s.paymentId, payeeSettledAt: null },
        data: { payeeSettledAt: now },
      });
      await tx.earningSettlement.updateMany({
        where: { id: s.id, status: 'owed' },
        data: {
          status: 'landed',
          settledAt: now,
          providerFeeKobo: fee,
          waiting: null,
          nextAttemptAt: null,
          ...(fig.feeKobo !== null && fee === null
            ? {
                discrepancy: joinNotes(
                  s.discrepancy,
                  `${this.provider.label} reported a charge of ${fig.feeKobo} kobo on the earning`,
                ),
              }
            : {}),
        },
      });
    });
    return this.resultOf(await this.load(s.id));
  }

  /**
   * Both sides of the move in the ledger: WAWU's account (money out) and the
   * person's wallet (money in), category `earning`, under our reference.
   * Best effort, like every ledger write after the money moved: the signed
   * delivery and the status check write them too, and the earning's own state
   * is the provider's record.
   */
  private async writeLedger(
    s: SettlementRow,
    fee: bigint | null,
    refs: {
      fintavaReference?: string | null;
      tagapayTransRef?: string | null;
      fintavaTransactionId?: string | null;
    },
    occurredAt: Date | null,
  ): Promise<void> {
    const dest = s.destinationAccountNumber;
    if (!dest) return;
    const amount = koboNumber(s.amountKobo);
    const payment = await this.prisma.walletPayment.findUnique({
      where: { id: s.paymentId },
      select: { payerWawuUserId: true },
    });
    const link = {
      kind: s.kind as PaymentKind,
      targetId: s.targetId,
      title: s.title,
    };
    const common = {
      status: 'completed' as const,
      category: 'earning' as const,
      link,
      narration: EARNING_NARRATION,
      references: { customerReference: s.customerReference, ...refs },
      // Our own move, known to us: the category, link and counterparty are
      // ours to set, however the ledger first heard of it.
      source: 'send' as const,
      ...(occurredAt ? { occurredAt } : {}),
    };
    // What the provider took from WAWU's account on top (R-31). A record that
    // carries no charge (Fintava's lookups) leaves the figures the row holds
    // standing; the schedule's charge only creates a row that is not there.
    const expected = this.expectedFeeKobo(s.amountKobo);
    const takenFee = fee ?? expected ?? 0n;
    const out: LedgerMovementInput = {
      ...common,
      wallet: { kind: 'merchant', accountNumber: s.merchantAccountNumber },
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
        wawuUserId: s.payeeWawuUserId,
        accountNumber: dest,
      },
    };
    const inn: LedgerMovementInput = {
      ...common,
      wallet: {
        kind: 'user',
        wawuUserId: s.payeeWawuUserId,
        accountNumber: dest,
      },
      direction: 'in',
      amountKobo: amount,
      feeKobo: 0,
      totalKobo: amount,
      // The earning comes from the person who paid for it; if their account
      // is gone it comes from WAWU. No account number of the other side.
      counterparty: payment?.payerWawuUserId
        ? {
            kind: 'wawu_user',
            name: null,
            wawuUserId: payment.payerWawuUserId,
            accountNumber: null,
          }
        : { kind: 'wawu', name: null },
    };
    for (const movement of [out, inn]) {
      try {
        await this.ledger.record(movement, undefined, { quiet: true });
      } catch (e) {
        this.logger.error(
          `earning ${s.id}: the ledger could not record the move (${e instanceof Error ? e.name : 'error'})`,
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
  // Waiting and review
  // -------------------------------------------------------------------------

  /**
   * Nothing has moved and the reason is a person's wallet, a provider out of
   * reach or another provider's sale. Every wait rests before the next look
   * and backs off to hourly: an earning waiting for a wallet by its age
   * (`walletWaitRestMs`) and woken as soon as the wallet exists, the rest by
   * the number of tries.
   */
  private async waitFor(
    s: SettlementRow,
    waiting: EarningWaiting,
    now: Date,
    slow = false,
  ): Promise<EarningSettlementResult> {
    const walletWait = (WALLET_WAITS as readonly string[]).includes(waiting);
    if (s.waiting !== waiting) {
      this.logger.warn(
        `earning ${s.id}: it waits (${waiting}); the money stays in WAWU's account`,
      );
    }
    // No review bound here: a missing wallet waits for as long as it takes
    // (R-11), and the provider being away is transient. The bound is for a
    // refusal with nothing moved, and is read where the refusal is (afterRefusal).
    await this.prisma.earningSettlement.updateMany({
      where: { id: s.id, status: 'owed', sentAt: null },
      data: {
        waiting,
        nextAttemptAt: new Date(
          now.getTime() +
            (walletWait
              ? walletWaitRestMs(now.getTime() - s.createdAt.getTime())
              : slow
                ? 60 * MINUTE
                : restMs(Math.max(s.attempts, 1))),
        ),
      },
    });
    return this.resultOf(await this.load(s.id));
  }

  /** Out of the sweep, for a person to look at. The money stays where it is. */
  private async toReview(
    s: SettlementRow,
    note: string,
  ): Promise<EarningSettlementResult> {
    const { count } = await this.prisma.earningSettlement.updateMany({
      where: { id: s.id, status: 'owed', reviewSince: null },
      data: {
        reviewSince: new Date(),
        nextAttemptAt: null,
        discrepancy: joinNotes(s.discrepancy, note),
      },
    });
    if (count > 0) {
      this.logger.error(`earning ${s.id}: ${note}; sent to review`);
    }
    return this.resultOf(await this.load(s.id));
  }

  // -------------------------------------------------------------------------
  // What the caller is told
  // -------------------------------------------------------------------------

  private resultOf(s: SettlementRow): EarningSettlementResult {
    let state: EarningSettlementState;
    if (s.status === 'landed') state = 'landed';
    else if (s.reviewSince) state = 'review';
    else if (s.sentAt) state = 'pending';
    else state = 'waiting';
    return {
      settlementId: s.id,
      paymentId: s.paymentId,
      state,
      waiting:
        state === 'waiting'
          ? ((s.waiting as EarningWaiting | null) ?? null)
          : null,
      status: s.status as EarningStatus,
    };
  }
}
