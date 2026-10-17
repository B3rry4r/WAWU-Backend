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
import { WalletProviderLimitError } from '../../wallet-provider/wallet-provider-limit';
import type { PaymentKind } from '../dto/money-enums';
import { FeeQuoteService } from '../fees/fee-quote.service';
import type { LedgerMovementInput } from '../ledger/ledger.interface';
import { koboNumber, LedgerService } from '../ledger/ledger.service';
import { PaymentSettings } from '../payments/payment-config';
import { joinNotes } from '../payments/payment-figures';
import { earningReference } from '../earnings/earning-rules';
import {
  type HoldAction,
  type HoldRef,
  HOLD_SWEEP_BUDGET_MS,
  HoldRequestError,
  type HoldSettlement,
  type HoldSettlementState,
  type HoldSweepCursor,
  type RefundOptions,
  type ReleaseOptions,
  type HoldWaiting,
  holdReference,
  REFUND_NARRATION,
  RELEASE_NARRATION,
  transferFor,
  WALLET_WAITS,
  walletWaitRestMs,
} from './hold-rules';

type HoldRow = Prisma.WalletHoldGetPayload<object>;

const MINUTE = 60_000;
/** Holds the sweep reads at a time. */
const SWEEP_PAGE = 50;

/** The rest before the next try or question: 1, 2, 4 ... minutes, at most an hour. */
function restMs(count: number): number {
  return Math.min(60, 2 ** Math.min(Math.max(count, 0), 6)) * MINUTE;
}

/**
 * Hold, release and refund (task MONEY-18, R-19).
 *
 * A paid DM, an event ticket or a bill is paid into WAWU's own account at the
 * wallet provider (MONEY-17); the payment's completion writes a `WalletHold`
 * for it. The price then waits there until the owning feature says what
 * happened:
 *
 * - **`release`** (a DM answered, an event that took place, a bill
 *   delivered): the payee's 85% moves from WAWU's account to the payee's
 *   wallet. The 15% is WAWU's and stays where it is; with no payee (a bill)
 *   nothing moves and the whole price is WAWU's (R-5). Asked with
 *   `asEarning` (a paid question, an event ticket; R-55, lead ruling 17 Oct
 *   2026) the share is not a transfer of its own: the release is one
 *   database write that settles the hold and makes the payee's
 *   `EarningSettlement`, which goes to their wallet in their ONE move a day
 *   with their other earnings (`EarningSettlementService`).
 * - **`refund`** (no answer in time, an event called off, a biller failure):
 *   the price moves back to the payer's wallet. The provider's charge on the
 *   original payment is not returned (R-10), unless the payer did not cause
 *   the refund and the owning feature asks `returnCharge` (the question
 *   that lapsed, a tip or unlock that could not be delivered, an event
 *   called off): then every naira comes back and WAWU bears the charge.
 *
 * The provider's charge on either move is WAWU's, paid from its 15% (R-31);
 * the payee and the payer receive the full figure.
 *
 * **Once.** A hold is settled once, one way. The owning feature's request
 * sets `action` in one conditional update (the first request wins; the same
 * request again is the same hold, and the other request is a
 * `HoldRequestError`), and the database refuses to change an action or leave
 * a settled state (the migration's trigger). The move itself goes out under
 * one reference of ours (`wawu-rel-<id>` or `wawu-ref-<id>`), so the
 * provider refuses a repeat, and it is handed over by a lease (`sentAt`)
 * only one caller wins. The hold id is therefore the Idempotency-Key of the
 * movement: asking again, from the feature, the sweep or a second server,
 * never moves it twice.
 *
 * **The provider's record is the truth.** The hold is `released` or
 * `refunded` only when the provider confirmed the move, from its answer to
 * the send, or from its record of our reference when the answer was lost. A
 * move whose outcome is unknown (a timeout, a 5xx, a transfer accepted and
 * not finished, a repeated reference) is asked about, backing off to
 * hourly, and is never sent again and never read as "nothing moved"; past
 * PAYMENT_REVIEW_AFTER_HOURS it goes to a person. Only the provider's own
 * record that the move failed starts a new try, under a new reference. A
 * balance is never added up from holds: the provider's is the only one.
 *
 * **Waiting is not failing.** A person with no wallet yet (R-11: the money
 * waits and lands within a minute of the wallet opening), a frozen wallet
 * (BACKEND_GAPS G-10: paid on unfreeze), WAWU's own account short of money
 * (an error in the log every try), the provider out of reach (including a
 * request that provably never reached it: the same reference is sent again):
 * the hold stays `held`, the money stays in WAWU's account, and the sweep
 * tries again. Nothing is ever refunded because a release is stuck, or the
 * other way round.
 *
 * Through the provider seam only (MONEY-20): a server acts only on holds of
 * the provider it runs.
 */
@Injectable()
export class WalletHoldService {
  private readonly logger = new Logger(WalletHoldService.name);
  private sweeping = false;
  /** Where the last pass stopped when its time ran out; null once it has read to the end. */
  private sweepAfter: HoldSweepCursor | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(WALLET_PROVIDER) private readonly provider: WalletProvider,
    private readonly ledger: LedgerService,
    private readonly fees: FeeQuoteService,
    private readonly settings: PaymentSettings,
  ) {}

  // -------------------------------------------------------------------------
  // What an owning feature calls
  // -------------------------------------------------------------------------

  /**
   * The payee gets the payee's share (the condition was met). Safe to ask
   * again. With `asEarning` the share becomes an earning of the payee that
   * travels in their one move a day (R-55) instead of a transfer of its own.
   */
  release(
    ref: HoldRef,
    reason?: string,
    opts: ReleaseOptions = {},
  ): Promise<HoldSettlement> {
    return this.request('release', ref, reason, opts);
  }

  /** The payer gets the price back (the condition will not be met). Safe to ask again. */
  refund(
    ref: HoldRef,
    reason?: string,
    opts: RefundOptions = {},
  ): Promise<HoldSettlement> {
    return this.request('refund', ref, reason, opts);
  }

  /**
   * What is held now, for the nightly check (MONEY-16): the holds still
   * `held` of the provider this server runs, counted and summed in kobo.
   * Money whose release or refund the provider has not confirmed is still
   * held. Compared with the provider's own balance by MONEY-16, never shown
   * as a balance.
   */
  async openTotals(): Promise<{ count: number; amountKobo: bigint }> {
    const rows = await this.prisma.walletHold.aggregate({
      where: { status: 'held', provider: this.provider.name },
      _count: { _all: true },
      _sum: { amountKobo: true },
    });
    return {
      count: rows._count._all,
      amountKobo: rows._sum.amountKobo ?? 0n,
    };
  }

  // -------------------------------------------------------------------------
  // The request
  // -------------------------------------------------------------------------

  private async request(
    action: HoldAction,
    ref: HoldRef,
    reason?: string,
    opts: RefundOptions & ReleaseOptions = {},
  ): Promise<HoldSettlement> {
    const hold = await this.find(ref);
    if (!hold) {
      throw new HoldRequestError(
        'no_such_hold',
        'There is no hold for that payment.',
      );
    }
    if (hold.action && hold.action !== action) {
      throw new HoldRequestError(
        'other_action_chosen',
        `This hold was already ${hold.action === 'release' ? 'released' : 'refunded'} or is being; it cannot also be ${action === 'release' ? 'released' : 'refunded'}.`,
      );
    }
    if (
      !hold.action &&
      action === 'release' &&
      opts.asEarning &&
      hold.payeeWawuUserId &&
      hold.payeeShareKobo > 0n
    ) {
      // The payee's share is an earning, moved with the rest of their day
      // (R-55): decided in one short database write, no provider call at all.
      await this.releaseAsEarning(hold, reason);
      const again = await this.load(hold.id);
      if (again.action && again.action !== action) {
        throw new HoldRequestError(
          'other_action_chosen',
          'This hold was settled the other way a moment ago.',
        );
      }
      return this.drive(hold.id);
    }
    if (!hold.action) {
      const now = new Date();
      const amount =
        transferFor(action, hold) +
        (action === 'refund' && opts.returnCharge
          ? await this.chargePaid(hold)
          : 0n);
      const nothingToMove =
        amount <= 0n || (action === 'release' && !hold.payeeWawuUserId);
      const base = {
        action,
        actionReason: reason ? reason.slice(0, 200) : null,
        actionAt: now,
      };
      const { count } = await this.prisma.walletHold.updateMany({
        where: { id: hold.id, status: 'held', action: null },
        data: nothingToMove
          ? // Nobody to pay and nothing to return: WAWU's own share stays in
            // its account and the hold is over, with no movement to confirm.
            { ...base, status: 'released', settledAt: now }
          : {
              ...base,
              transferKobo: amount,
              customerReference: holdReference(action, hold.id, 1),
              attempt: 1,
            },
      });
      if (count === 0) {
        // Another request got there first: it is this hold's now.
        const again = await this.load(hold.id);
        if (again.action && again.action !== action) {
          throw new HoldRequestError(
            'other_action_chosen',
            'This hold was settled the other way a moment ago.',
          );
        }
      } else if (nothingToMove) {
        // Nobody to pay, or a share too small to move (nothing owed): the
        // payee's share is as paid as it will ever be.
        if (hold.payeeWawuUserId) await this.markPayeeSettled(hold);
        return this.settlementOf(await this.load(hold.id));
      }
    }
    return this.drive(hold.id);
  }

  /**
   * Decides a release as an earning (R-55): in ONE short transaction, holding
   * nothing across a call, the hold becomes `released` (the conditional write
   * is the decision: the first request wins) and the payee's
   * `EarningSettlement` for the payment is made with it, for exactly the
   * payee's share, owed in WAWU's account. The hold's `transferKobo` and
   * reference stay null: nothing is sent here, the daily move sends. Nothing
   * is written when another request decided first.
   */
  private async releaseAsEarning(
    hold: HoldRow,
    reason?: string,
  ): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.walletHold.updateMany({
        where: { id: hold.id, status: 'held', action: null },
        data: {
          action: 'release',
          actionReason: reason ? reason.slice(0, 200) : null,
          actionAt: now,
          status: 'released',
          settledAt: now,
        },
      });
      if (count === 0) return;
      await tx.earningSettlement.create({
        data: {
          paymentId: hold.paymentId,
          payeeWawuUserId: hold.payeeWawuUserId!,
          kind: hold.kind,
          targetId: hold.targetId,
          title: hold.title,
          earnedAt: now,
          amountKobo: hold.payeeShareKobo,
          merchantAccountNumber: hold.merchantAccountNumber,
          provider: hold.provider,
          customerReference: earningReference(hold.paymentId, 1),
        },
      });
    });
  }

  /** What the payment took on top of the price (the provider's charge and WAWU's fee), in kobo; never below nothing. */
  private async chargePaid(hold: HoldRow): Promise<bigint> {
    const paid = await this.prisma.walletPayment.findUnique({
      where: { id: hold.paymentId },
      select: { totalKobo: true, priceKobo: true },
    });
    if (!paid) return 0n;
    const extra = paid.totalKobo - paid.priceKobo;
    return extra > 0n ? extra : 0n;
  }

  private find(ref: HoldRef): Promise<HoldRow | null> {
    return 'holdId' in ref
      ? this.prisma.walletHold.findUnique({ where: { id: ref.holdId } })
      : this.prisma.walletHold.findUnique({
          where: { paymentId: ref.paymentId },
        });
  }

  private load(id: string): Promise<HoldRow> {
    return this.prisma.walletHold.findUniqueOrThrow({ where: { id } });
  }

  // -------------------------------------------------------------------------
  // The sweep
  // -------------------------------------------------------------------------

  /**
   * Every minute: every hold whose action was chosen and whose move is not
   * confirmed, not under review and due, of the provider this server runs.
   *
   * MONEY-18 round 2 (F4): the pass walks EVERY due hold by a keyset cursor
   * (action time, then id), with no cap on the rows it looks at, the way
   * NUV-02's expiry sweep does. It stops only at the end of the due holds or
   * when its time is used (`budgetMs`), and then the next pass starts where
   * this one stopped, so no number of holds in front can keep it from the
   * ones behind. A hold waiting for a person's wallet rests (a minute to an
   * hour, by its age) instead of being due on every pass, and is woken the
   * moment its person has a wallet (R-11).
   */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'money-hold-settle' })
  async sweep(
    now = new Date(),
    opts: { budgetMs?: number } = {},
  ): Promise<{ checked: number; settled: number }> {
    const counts = { checked: 0, settled: 0 };
    if (this.sweeping) return counts;
    this.sweeping = true;
    const budgetMs = opts.budgetMs ?? HOLD_SWEEP_BUDGET_MS;
    const started = Date.now();
    try {
      await this.wakeWalletWaiters(now);
      let after: HoldSweepCursor | null = this.sweepAfter;
      for (;;) {
        const where: Prisma.WalletHoldWhereInput = {
          status: 'held',
          action: { not: null },
          reviewSince: null,
          provider: this.provider.name,
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
          ...(after
            ? {
                AND: [
                  {
                    OR: [
                      { actionAt: { gt: after.at } },
                      { actionAt: after.at, id: { gt: after.id } },
                    ],
                  },
                ],
              }
            : {}),
        };
        const due = await this.prisma.walletHold.findMany({
          where,
          orderBy: [{ actionAt: 'asc' }, { id: 'asc' }],
          take: SWEEP_PAGE,
          select: { id: true, actionAt: true },
        });
        for (const { id, actionAt } of due) {
          counts.checked += 1;
          try {
            const s = await this.drive(id, now);
            if (s.state === 'settled') counts.settled += 1;
          } catch (e) {
            this.logger.error(
              `hold ${id}: the sweep could not drive it (${e instanceof Error ? e.name : 'error'})`,
            );
          }
          // Out of time (a slow provider spends it a hold at a time): the
          // next pass starts after this hold.
          if (Date.now() - started >= budgetMs) {
            this.sweepAfter = { at: actionAt!, id };
            return counts;
          }
        }
        if (due.length < SWEEP_PAGE) {
          // Read to the end: the next pass starts from the front again.
          this.sweepAfter = null;
          break;
        }
        const last = due[due.length - 1];
        after = { at: last.actionAt!, id: last.id };
      }
    } catch (e) {
      this.logger.error(
        `hold sweep failed: ${e instanceof Error ? e.message : 'unknown'}`,
      );
    } finally {
      this.sweeping = false;
    }
    return counts;
  }

  /**
   * A hold that waits for a person's wallet rests until its next look; one
   * whose person has a wallet NOW is made due at once, so the money lands in
   * the first sweep after the wallet opens (R-11) however long it had rested.
   * Only the running provider's wallets count (a wallet of the other
   * provider is not a place this server can send to).
   */
  private async wakeWalletWaiters(now: Date): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        UPDATE "WalletHold" h
           SET "nextAttemptAt" = NULL
         WHERE h."status" = 'held' AND h."action" IS NOT NULL
           AND h."reviewSince" IS NULL AND h."sentAt" IS NULL
           AND h."provider" = ${this.provider.name}
           AND h."waiting" IN ('payee_wallet', 'payer_wallet')
           AND h."nextAttemptAt" > ${now}
           AND EXISTS (
             SELECT 1 FROM "FintavaWallet" w
              WHERE w."wawuUserId" = CASE WHEN h."action" = 'release'
                                          THEN h."payeeWawuUserId"
                                          ELSE h."payerWawuUserId" END
                AND LOWER(BTRIM(COALESCE(w."provider", 'fintava'))) = ${this.provider.name})`;
    } catch (e) {
      // The waiters keep their rest and are looked at when it ends.
      this.logger.error(
        `hold sweep: could not wake the holds waiting for a wallet (${e instanceof Error ? e.name : 'error'})`,
      );
    }
  }

  /**
   * Moves a hold one step: asks the provider about a move that was handed
   * over, or hands it over. Never sends a move whose outcome is unknown.
   */
  async drive(holdId: string, now = new Date()): Promise<HoldSettlement> {
    const hold = await this.load(holdId);
    if (hold.status !== 'held' || !hold.action) return this.settlementOf(hold);
    if (hold.reviewSince) return this.settlementOf(hold);
    // Not yet due: a lease on a call in flight, or a back-off.
    if (hold.nextAttemptAt && hold.nextAttemptAt.getTime() > now.getTime()) {
      return this.settlementOf(hold);
    }
    if (!isRowOf(this.provider.name, hold.provider)) {
      // Another provider holds this money (written before a switch of
      // WALLET_PROVIDER): this one's silence says nothing and it sends
      // nothing. It waits for its own provider.
      return this.waitFor(hold, 'provider', now, true);
    }
    return hold.sentAt ? this.reconcile(hold, now) : this.send(hold, now);
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  private async send(hold: HoldRow, now: Date): Promise<HoldSettlement> {
    const action = hold.action as HoldAction;
    const amount = hold.transferKobo!;
    const cap = this.fees.providerFees.merchantMaxPerTxnKobo;
    if (cap !== null && amount > BigInt(cap)) {
      // Refuse, never split (WALLET.md, lead ruling 1): a person decides.
      return this.toReview(
        hold,
        `${action} of ${amount} kobo is above the cap of ${cap} kobo on one move through WAWU's account`,
      );
    }

    const destination = await this.destination(hold);
    if (destination.kind === 'wait') {
      return this.waitFor(hold, destination.waiting, now);
    }
    if (destination.kind === 'review') {
      return this.toReview(hold, destination.note);
    }
    if (
      await this.isWawuAccount(hold.merchantAccountNumber, destination.account)
    ) {
      return this.toReview(
        hold,
        `the ${action} would move money from WAWU's account to WAWU's account`,
      );
    }

    // The lease: only the caller that wins it hands the move to the provider.
    // `sentAt` set means a record may exist at the provider from here on.
    const leaseUntil = new Date(
      now.getTime() +
        this.provider.timings.moneyTimeoutMs +
        this.provider.timings.resendSafetyMs,
    );
    const leased = await this.prisma.walletHold.updateMany({
      where: {
        id: hold.id,
        status: 'held',
        action,
        reviewSince: null,
        sentAt: null,
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      data: {
        sentAt: now,
        nextAttemptAt: leaseUntil,
        attempts: { increment: 1 },
        waiting: null,
        destinationAccountNumber: destination.account,
      },
    });
    if (leased.count === 0) {
      return this.settlementOf(await this.load(hold.id));
    }

    let receipt: ProviderTransferReceipt;
    try {
      receipt = await this.provider.walletToWallet({
        fromAccountNumber: hold.merchantAccountNumber,
        toAccountNumber: destination.account,
        amountKobo: amount,
        reference: hold.customerReference!,
        narration: action === 'release' ? RELEASE_NARRATION : REFUND_NARRATION,
      });
    } catch (e) {
      return this.afterRefusal(hold, e, now);
    }
    return this.afterReceipt(
      { ...hold, destinationAccountNumber: destination.account },
      receipt,
    );
  }

  /** Where the money goes, or why it cannot go yet. */
  private async destination(
    hold: HoldRow,
  ): Promise<
    | { kind: 'ok'; account: string }
    | { kind: 'wait'; waiting: HoldWaiting }
    | { kind: 'review'; note: string }
  > {
    const release = hold.action === 'release';
    const person = release ? hold.payeeWawuUserId : hold.payerWawuUserId;
    if (!person) {
      // The payer's account is gone (a refund has nobody to go to) or the
      // payee has none: WAWU keeps the money until a person decides.
      return {
        kind: 'review',
        note: release
          ? 'the payee is not on record'
          : "the payer's account was deleted, so there is nowhere to refund to",
      };
    }
    const wallet = await this.prisma.fintavaWallet.findUnique({
      where: { wawuUserId: person },
      select: { accountNumber: true, provider: true },
    });
    if (!wallet || !isRowOf(this.provider.name, wallet.provider)) {
      return {
        kind: 'wait',
        waiting: release ? 'payee_wallet' : 'payer_wallet',
      };
    }
    return { kind: 'ok', account: wallet.accountNumber };
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
    hold: HoldRow,
    e: unknown,
    now: Date,
  ): Promise<HoldSettlement> {
    const refusal = e instanceof WalletProviderError ? e : null;
    if (!refusal || (refusal.recordMayExist && !refusal.requestNotSent)) {
      // Money may have moved (a lost answer, a transfer accepted and not
      // finished, a repeated reference): asked about, never sent again.
      // A request that PROVABLY never reached the provider (a refused
      // connection, a host name that did not resolve: `requestNotSent`)
      // is not here: nothing was sent, so it is the refusal below.
      this.logger.warn(
        `hold ${hold.id}: the ${hold.action} outcome is unknown (${refusal?.kind ?? 'error'}); asking ${this.provider.label} about it`,
      );
      await this.schedule(hold, now, 1);
      return this.settlementOf(await this.load(hold.id));
    }
    // A refusal that moved nothing: the lease is given back, the same
    // reference is used again (a refused send does not use it up).
    let waiting: HoldWaiting;
    if (refusal.requestNotSent) {
      this.logger.warn(
        `hold ${hold.id}: ${this.provider.label} could not be reached (the request was not sent); the ${hold.action} is tried again under the same reference`,
      );
      waiting = 'provider';
    } else if (refusal instanceof WalletProviderLimitError) {
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
        `hold ${hold.id}: ${this.provider.label} says WAWU's own account cannot cover the ${hold.action} (${hold.transferKobo} kobo): held money is not where it should be`,
      );
    } else if (waiting === 'refused') {
      this.logger.error(
        `hold ${hold.id}: ${this.provider.label} refused the ${hold.action} (${refusal.kind}); nothing moved`,
      );
    }
    await this.prisma.walletHold.updateMany({
      where: { id: hold.id, status: 'held', sentAt: { not: null } },
      data: {
        sentAt: null,
        waiting,
        nextAttemptAt: new Date(now.getTime() + restMs(hold.attempts + 1)),
      },
    });
    // The review bound applies to a refusal with nothing moved (a person has
    // to look at why), CONVENTIONS section 26. The lease is already given
    // back above, so the hold goes to review with nothing handed over.
    if (waiting === 'refused' && this.refusedTooLong(hold, now)) {
      return this.toReview(
        hold,
        `the ${hold.action} has been refused for ${this.settings.reviewAfterHours} hours`,
      );
    }
    return this.settlementOf(await this.load(hold.id));
  }

  /** Whether a hold's action has been refused for as long as the review bound, counted from when the action was asked for. */
  private refusedTooLong(hold: HoldRow, now: Date): boolean {
    return (
      now.getTime() - (hold.actionAt ?? hold.createdAt).getTime() >=
      this.settings.reviewAfterHours * 3_600_000
    );
  }

  /** The provider confirmed the move in its answer. */
  private async afterReceipt(
    hold: HoldRow,
    receipt: ProviderTransferReceipt,
  ): Promise<HoldSettlement> {
    if (receipt.amountKobo !== hold.transferKobo) {
      // It moved another amount than asked: a stop. The ledger is not
      // written with a figure we did not ask for; a person looks.
      return this.toReview(
        hold,
        `${this.provider.label} moved ${receipt.amountKobo} kobo for a ${hold.action} of ${hold.transferKobo} kobo`,
      );
    }
    return this.settle(hold, {
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

  private async reconcile(hold: HoldRow, now: Date): Promise<HoldSettlement> {
    let answer: ProviderReconciliation | null = null;
    try {
      answer = await this.provider.reconcileSend(
        hold.customerReference!,
        { kind: 'merchant' },
        hold.sentAt ?? hold.actionAt ?? hold.createdAt,
      );
    } catch (e) {
      this.logger.warn(
        `hold ${hold.id}: ${this.provider.label} could not be asked (${e instanceof WalletProviderError ? e.kind : 'error'})`,
      );
    }
    if (answer?.state === 'found') {
      const t = answer.transaction;
      if (t.outcome === 'completed') {
        if (t.amountKobo !== hold.transferKobo) {
          return this.toReview(
            hold,
            `${this.provider.label} moved ${t.amountKobo} kobo for a ${hold.action} of ${hold.transferKobo} kobo`,
          );
        }
        const tagapay =
          t.secondaryReference ??
          (await this.provider.secondaryReferenceOf(t).catch(() => null));
        return this.settle(hold, {
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
        // where it was. Only this starts a new try, under a new reference.
        return this.retryAfterFailure(hold, now);
      }
      if (t.outcome === 'reversed') {
        return this.toReview(
          hold,
          `${this.provider.label} moved the ${hold.action} and then reversed it; WAWU's account holds the money again`,
        );
      }
      // Pending, or a word we do not know: neither says no money moved.
    }
    return this.stillUnknown(hold, now);
  }

  /** Still unknown: asked again later, or sent to a person past the bound. */
  private async stillUnknown(
    hold: HoldRow,
    now: Date,
  ): Promise<HoldSettlement> {
    const since = (hold.sentAt ?? hold.actionAt ?? hold.createdAt).getTime();
    if (now.getTime() - since >= this.settings.reviewAfterHours * 3_600_000) {
      return this.toReview(
        hold,
        `no answer from ${this.provider.label} about the ${hold.action} after ${this.settings.reviewAfterHours} hours; it may have moved`,
      );
    }
    await this.schedule(hold, now, hold.checks + 1);
    return this.settlementOf(await this.load(hold.id));
  }

  /** The next question to the provider, with the rest doubling each time. */
  private async schedule(
    hold: HoldRow,
    now: Date,
    checks: number,
  ): Promise<void> {
    await this.prisma.walletHold.updateMany({
      where: { id: hold.id, status: 'held' },
      data: {
        checks: { increment: 1 },
        nextAttemptAt: new Date(now.getTime() + restMs(checks)),
      },
    });
  }

  /** The provider's record says the move failed: a new try, a new reference. */
  private async retryAfterFailure(
    hold: HoldRow,
    now: Date,
  ): Promise<HoldSettlement> {
    const attempt = hold.attempt + 1;
    this.logger.warn(
      `hold ${hold.id}: ${this.provider.label} says the ${hold.action} failed; trying again as attempt ${attempt}`,
    );
    await this.prisma.walletHold.updateMany({
      where: {
        id: hold.id,
        status: 'held',
        sentAt: { not: null },
        customerReference: hold.customerReference,
      },
      data: {
        attempt,
        customerReference: holdReference(
          hold.action as HoldAction,
          hold.id,
          attempt,
        ),
        sentAt: null,
        checks: 0,
        waiting: 'refused',
        nextAttemptAt: new Date(now.getTime() + restMs(attempt)),
      },
    });
    return this.settlementOf(await this.load(hold.id));
  }

  // -------------------------------------------------------------------------
  // Settling
  // -------------------------------------------------------------------------

  /**
   * The provider confirmed the move: the ledger gets both sides, the hold
   * becomes `released` or `refunded`, and a release marks the payment's
   * payee share as paid (so WALLET-16 never lands it again).
   */
  private async settle(
    hold: HoldRow,
    fig: {
      feeKobo: bigint | null;
      refs: {
        fintavaReference?: string | null;
        tagapayTransRef?: string | null;
        fintavaTransactionId?: string | null;
      };
      occurredAt: Date | null;
    },
  ): Promise<HoldSettlement> {
    const action = hold.action as HoldAction;
    // A negative charge is nothing a provider charges: the move stands, the
    // charge is not recorded as a figure, and the hold says why.
    const fee = fig.feeKobo !== null && fig.feeKobo >= 0n ? fig.feeKobo : null;
    await this.writeLedger(hold, fee, fig.refs, fig.occurredAt);
    const now = new Date();
    const { count } = await this.prisma.walletHold.updateMany({
      where: { id: hold.id, status: 'held', action },
      data: {
        status: action === 'release' ? 'released' : 'refunded',
        settledAt: now,
        refundedKobo: action === 'refund' ? hold.amountKobo : null,
        providerFeeKobo: fee,
        waiting: null,
        nextAttemptAt: null,
        ...(fig.feeKobo !== null && fee === null
          ? {
              discrepancy: joinNotes(
                hold.discrepancy,
                `${this.provider.label} reported a charge of ${fig.feeKobo} kobo on the ${action}`,
              ),
            }
          : {}),
      },
    });
    if (count > 0 && action === 'release') await this.markPayeeSettled(hold);
    return this.settlementOf(await this.load(hold.id));
  }

  /** WALLET-16 lands the payee share of an ordinary payment; a released hold's is paid. */
  private async markPayeeSettled(hold: HoldRow): Promise<void> {
    await this.prisma.walletPayment.updateMany({
      where: { id: hold.paymentId, payeeSettledAt: null },
      data: { payeeSettledAt: new Date() },
    });
  }

  /**
   * Both sides of the move in the ledger: WAWU's account (money out) and the
   * person's wallet (money in), under our reference. Best effort, like every
   * ledger write after the money moved: the signed delivery and the status
   * check write them too, and the hold's own state is the provider's record.
   */
  private async writeLedger(
    hold: HoldRow,
    fee: bigint | null,
    refs: {
      fintavaReference?: string | null;
      tagapayTransRef?: string | null;
      fintavaTransactionId?: string | null;
    },
    occurredAt: Date | null,
  ): Promise<void> {
    const action = hold.action as HoldAction;
    const dest = hold.destinationAccountNumber;
    if (!dest || !hold.customerReference) return;
    const amount = koboNumber(hold.transferKobo!);
    const person =
      action === 'release' ? hold.payeeWawuUserId : hold.payerWawuUserId;
    if (!person) return;
    const category =
      action === 'release' ? ('earning' as const) : ('refund' as const);
    const link = {
      kind: hold.kind as PaymentKind,
      targetId: hold.targetId,
      title: hold.title,
    };
    const common = {
      status: 'completed' as const,
      category,
      link,
      narration: action === 'release' ? RELEASE_NARRATION : REFUND_NARRATION,
      references: { customerReference: hold.customerReference, ...refs },
      // Our own move, known to us: the category, link and counterparty are
      // ours to set, however the ledger first heard of it.
      source: 'send' as const,
      ...(occurredAt ? { occurredAt } : {}),
    };
    // What the provider took from WAWU's account on top (R-31). A record that
    // carries no charge (Fintava's lookups) leaves the figures the row holds
    // standing; the schedule's charge only creates a row that is not there.
    const expected = this.expectedFeeKobo(hold.transferKobo!);
    const takenFee = fee ?? expected ?? 0n;
    const out: LedgerMovementInput = {
      ...common,
      wallet: { kind: 'merchant', accountNumber: hold.merchantAccountNumber },
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
        wawuUserId: person,
        accountNumber: dest,
      },
    };
    const inn: LedgerMovementInput = {
      ...common,
      wallet: { kind: 'user', wawuUserId: person, accountNumber: dest },
      direction: 'in',
      amountKobo: amount,
      feeKobo: 0,
      totalKobo: amount,
      // The earning comes from the person who paid for it; a refund comes
      // from WAWU. Neither carries anyone's account number.
      counterparty:
        action === 'release' && hold.payerWawuUserId
          ? {
              kind: 'wawu_user',
              name: null,
              wawuUserId: hold.payerWawuUserId,
              accountNumber: null,
            }
          : { kind: 'wawu', name: null },
    };
    for (const movement of [out, inn]) {
      try {
        await this.ledger.record(movement, undefined, { quiet: true });
      } catch (e) {
        this.logger.error(
          `hold ${hold.id}: the ledger could not record the ${action} (${e instanceof Error ? e.name : 'error'})`,
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
   * Nothing has moved and the reason is a person's wallet, a frozen wallet,
   * a provider out of reach or a refusal. Every wait rests before the next
   * look and backs off to hourly: a hold waiting for a wallet by its age
   * (`walletWaitRestMs`) and woken as soon as the wallet exists, the rest by
   * the number of tries.
   */
  private async waitFor(
    hold: HoldRow,
    waiting: HoldWaiting,
    now: Date,
    slow = false,
  ): Promise<HoldSettlement> {
    const walletWait = WALLET_WAITS.includes(waiting);
    if (hold.waiting !== waiting) {
      this.logger.warn(
        `hold ${hold.id}: the ${hold.action} waits (${waiting}); the money stays in WAWU's account`,
      );
    }
    // No review bound here: a missing wallet or a frozen one waits for as long
    // as it takes (R-11, G-10), and the provider being away is transient. The
    // bound is for a refusal with nothing moved, and is read where the refusal
    // is (afterRefusal).
    await this.prisma.walletHold.updateMany({
      where: { id: hold.id, status: 'held', sentAt: null },
      data: {
        waiting,
        nextAttemptAt: new Date(
          now.getTime() +
            (walletWait
              ? walletWaitRestMs(
                  now.getTime() - (hold.actionAt ?? hold.createdAt).getTime(),
                )
              : slow
                ? 60 * MINUTE
                : restMs(Math.max(hold.attempts, 1))),
        ),
      },
    });
    return this.settlementOf(await this.load(hold.id));
  }

  /** Out of the sweep, for a person to look at. The money stays where it is. */
  private async toReview(hold: HoldRow, note: string): Promise<HoldSettlement> {
    const { count } = await this.prisma.walletHold.updateMany({
      where: { id: hold.id, status: 'held', reviewSince: null },
      data: {
        reviewSince: new Date(),
        nextAttemptAt: null,
        discrepancy: joinNotes(hold.discrepancy, note),
      },
    });
    if (count > 0) {
      this.logger.error(`hold ${hold.id}: ${note}; sent to review`);
    }
    return this.settlementOf(await this.load(hold.id));
  }

  // -------------------------------------------------------------------------
  // What the caller is told
  // -------------------------------------------------------------------------

  private settlementOf(hold: HoldRow): HoldSettlement {
    let state: HoldSettlementState;
    if (hold.status !== 'held') state = 'settled';
    else if (hold.reviewSince) state = 'review';
    else if (hold.sentAt) state = 'pending';
    else state = 'waiting';
    return {
      holdId: hold.id,
      paymentId: hold.paymentId,
      action: (hold.action ?? 'release') as HoldAction,
      state,
      waiting:
        state === 'waiting'
          ? ((hold.waiting as HoldWaiting | null) ?? null)
          : null,
      status: hold.status as HoldSettlement['status'],
    };
  }
}
