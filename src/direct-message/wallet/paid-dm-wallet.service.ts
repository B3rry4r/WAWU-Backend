import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '../../../generated/prisma/client';
import type { PaidDmDraft } from '../../../generated/prisma/client';
import { WawuIdClient } from '../../common/auth/wawu-id.client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { BlockedAccountService } from '../../blocked-account/blocked-account.service';
import type { OpenWallet } from '../../money/gate/wallet-gate';
import { HoldRequestError } from '../../money/holds/hold-rules';
import { WalletHoldService } from '../../money/holds/wallet-hold.service';
import { loadMoneyParties } from '../../money/money-party';
import { MoneyError } from '../../money/money-error';
import type { MoneyPartyView, PaymentView } from '../../money/money-view.type';
import type { IdempotencyScope } from '../../money/payments/idempotency';
import {
  type CompletedPayment,
  type PayableLookup,
  PayableRegistry,
  type PayableTarget,
} from '../../money/payments/payable-registry';
import { WalletPaymentService } from '../../money/payments/wallet-payment.service';
import { isUniqueViolationOn } from '../../money/prisma-unique';
import { NotificationService } from '../../notification/notification.service';
import { replyTimesFor } from '../../professional/professional-reply-time';
import {
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import { DmAnsweredHooks } from '../dm-answered-hooks';
import { PaidDmPauseService } from '../paid-dm-pause.service';
import type {
  AskPaidQuestionDto,
  PayPaidQuestionDto,
} from './paid-dm-wallet.dto';
import {
  ALREADY_SENT,
  ALREADY_WAITING,
  ANSWERED_REASON,
  BLOCKED_MESSAGE,
  CREATOR_NOT_FOUND,
  deadlineOf,
  DRAFT_KEEP_DAYS,
  KEY_MALFORMED,
  KEY_PATTERN,
  KEY_REUSED,
  KOBO_PER_NAIRA,
  NOT_ACCEPTING,
  OWN_QUESTION,
  PAID_DM_KIND,
  PAID_DM_PAY_ROUTE,
  type PaidQuestionStatus,
  paymentIdOfTxRef,
  PAUSED_MESSAGE,
  QUESTION_NOT_FOUND,
  UNANSWERED_REASON,
  UNDELIVERED_REASON,
  walletDmTxRef,
} from './paid-dm-wallet-rules';
import type {
  PaidQuestionDraftView,
  PaidQuestionQuoteView,
  PaidQuestionWalletView,
} from './paid-dm-wallet-view.type';

/** Rows one pass of the sweep reads for each of its steps. */
const SWEEP_PAGE = 100;

/** What the sweep did, for logs and tests. */
export interface PaidDmWalletSweepCounts {
  /** Questions whose window passed unanswered and whose refund was chosen. */
  expired: number;
  /** Answered questions whose held price was released to the creator in this pass. */
  released: number;
  /** Refunds the provider had confirmed, told to the payer in this pass. */
  refundsSettled: number;
  /** Abandoned drafts removed. */
  draftsRemoved: number;
}

type Db = Prisma.TransactionClient | PrismaService;

/**
 * Paid questions from the wallet (task INBOX-17, I3 to I5). The web's
 * `POST /dm/{creatorWawuId}/send` and `/send/verify` (Flutterwave) are
 * unchanged; these routes sit under `dm/{creatorWawuId}/send/wallet` and
 * `dm/send/wallet`, paths no route of the web matches.
 *
 * - **A question is drafted, then paid.** The words wait in `PaidDmDraft`
 *   (the creator's inbox never shows an unpaid question). The draft's id is
 *   the payment's `targetId` and, once paid, the id of the `DirectMessage`.
 * - **Held, not paid out (R-19).** A paid question is a held `paid_dm`
 *   payment: the price moves into WAWU's own account and the provider's
 *   charge is on top (R-10). Nothing reaches the creator until they answer.
 *   The quote, the PIN, the Idempotency-Key, the daily limit and the provider
 *   seam (R-39) are the payment service's; this file reaches no provider.
 * - **One way, once.** The creator's answer flips the question
 *   `awaiting_response` to `responded` with one conditional write; the window
 *   passing flips it to `refunded` with another. They cannot both match, and
 *   each then asks the hold for its one outcome: the answer RELEASES the
 *   creator's 85% as an earning that goes in their one move a day (R-5, R-11,
 *   R-55: it waits for a wallet they have not opened), the expiry REFUNDS
 *   every naira, the payment's charge included (the fan did not cause it;
 *   lead ruling 17 Oct 2026) with WAWU bearing the refund's own charge. The
 *   hold itself refuses the second outcome after the first. Both
 *   are asked after the flip commits, holding nothing, and the minute sweep
 *   asks again for any the request did not finish.
 * - **One question waits per creator** (G-75). A fan with a question still
 *   waiting on a creator cannot pay another to them: refused when drafted and
 *   again inside the payment's claim under a lock (`question_already_waiting`),
 *   so two taps on two drafts pay one.
 * - **The creator's standing counts** (INBOX-09). A creator who switched paid
 *   messages off, or whom the no-reply rule paused, is not payable.
 * - **A question that cannot be sent is paid back whole.** If the creator
 *   went, switched paid messages off, was paused or blocked the payer between
 *   the quote and the confirmed debit, nothing was asked of them: the price
 *   and everything the payment took return, and WAWU carries the charge.
 */
@Injectable()
export class PaidDmWalletService implements OnModuleInit {
  private readonly logger = new Logger(PaidDmWalletService.name);
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: WalletPaymentService,
    private readonly registry: PayableRegistry,
    private readonly holds: WalletHoldService,
    private readonly blocked: BlockedAccountService,
    private readonly pause: PaidDmPauseService,
    private readonly answered: DmAnsweredHooks,
    private readonly notifications: NotificationService,
    private readonly wawuId: WawuIdClient,
    @Inject(WALLET_PROVIDER) private readonly provider: WalletProvider,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      kind: PAID_DM_KIND,
      resolve: (lookup) => this.resolve(lookup),
      beforeClaim: (lookup, tx) => this.assertNothingWaiting(lookup, tx),
      onCompleted: (payment) => this.deliver(payment),
    });
    this.payments.presentRoute(PAID_DM_PAY_ROUTE, (view) => this.present(view));
    this.answered.register((message) => this.release(message));
  }

  // -------------------------------------------------------------------------
  // The routes
  // -------------------------------------------------------------------------

  /**
   * Drafts a question to a creator and answers I3: the question priced by the
   * server and the wallet payment's quote. Nothing is reserved and nothing is
   * debited. With an `Idempotency-Key`, the same key and the same question
   * answer the same draft, so a repeated tap never makes a second one.
   */
  async ask(
    wallet: OpenWallet,
    creatorWawuId: string,
    dto: AskPaidQuestionDto,
    key?: string,
  ): Promise<PaidQuestionQuoteView> {
    if (key !== undefined && !KEY_PATTERN.test(key)) {
      throw new MoneyError('idempotency_key_required', KEY_MALFORMED);
    }
    const sender = wallet.wawuUserId;
    if (key !== undefined) {
      const again = await this.sameKey(sender, key, creatorWawuId, dto.text);
      if (again) return this.quoteOf(wallet, again);
    }
    const terms = await this.askable(this.prisma, sender, creatorWawuId);
    let draft: PaidDmDraft;
    try {
      draft = await this.prisma.paidDmDraft.create({
        data: {
          senderWawuId: sender,
          creatorWawuId,
          text: dto.text,
          responseWindowHours: terms.responseWindowHours,
          requestKey: key ?? null,
        },
      });
    } catch (e) {
      if (key !== undefined && isUniqueViolationOn(e, 'requestKey')) {
        // Two taps at once under one key: the first one's draft is the answer.
        const again = await this.sameKey(sender, key, creatorWawuId, dto.text);
        if (again) return this.quoteOf(wallet, again);
      }
      throw e;
    }
    return this.quoteOf(wallet, draft);
  }

  /** The pay sheet again: I3 reopened, or a quote past its `expiresAt`. */
  async quote(
    wallet: OpenWallet,
    questionId: string,
  ): Promise<PaidQuestionQuoteView> {
    return this.quoteOf(
      wallet,
      await this.owned(wallet.wawuUserId, questionId),
    );
  }

  /** Pays the question from the wallet (I3 Send, W11 PIN). Answers and replays as the question. */
  async pay(
    wallet: OpenWallet,
    scope: IdempotencyScope,
    dto: PayPaidQuestionDto,
  ): Promise<PaidQuestionWalletView> {
    const draft = await this.owned(wallet.wawuUserId, dto.questionId);
    const payment = await this.payments.pay(
      wallet,
      {
        kind: PAID_DM_KIND,
        targetId: draft.id,
        expectedTotalKobo: dto.expectedTotalKobo,
        quoteToken: dto.quoteToken,
      },
      scope,
    );
    return (
      (scope.answered as PaidQuestionWalletView | undefined) ??
      this.present(payment)
    );
  }

  /** One question as it stands now: what the app polls after `pending` (I4). Only the asker reads it. */
  async read(
    wawuUserId: string,
    questionId: string,
  ): Promise<PaidQuestionWalletView> {
    const draft = await this.owned(wawuUserId, questionId);
    const payment = await this.prisma.walletPayment.findFirst({
      where: { kind: PAID_DM_KIND, targetId: draft.id },
      orderBy: { createdAt: 'desc' },
    });
    const view = payment
      ? this.payments.view(payment, await this.payments.holdOf(payment))
      : null;
    return this.build(draft, view);
  }

  // -------------------------------------------------------------------------
  // The payment's side: what is priced, and what is delivered
  // -------------------------------------------------------------------------

  /** Prices the question (I3). Moves nothing. */
  private async resolve(lookup: PayableLookup): Promise<PayableTarget> {
    const draft = await this.prisma.paidDmDraft.findFirst({
      where: { id: lookup.targetId, senderWawuId: lookup.payerWawuUserId },
    });
    if (!draft) throw new MoneyError('target_not_found', QUESTION_NOT_FOUND);
    if (
      await this.prisma.directMessage.findUnique({
        where: { id: draft.id },
        select: { id: true },
      })
    ) {
      throw new MoneyError('target_not_payable', ALREADY_SENT);
    }
    const terms = await this.askable(
      this.prisma,
      draft.senderWawuId,
      draft.creatorWawuId,
      draft.id,
    );
    const party = await this.party(draft.creatorWawuId);
    return {
      title: `Question for ${party?.displayName || party?.handle || 'a creator'}`,
      priceKobo: terms.priceKobo,
      payee: party ?? {
        wawuUserId: draft.creatorWawuId,
        displayName: '',
        handle: null,
        avatarUrl: null,
        tick: null,
      },
    };
  }

  /**
   * Inside the payment's claim (PayableKindHandler.beforeClaim): takes one
   * short advisory lock for this fan and this creator, counts what is
   * waiting, and refuses the payment that would be a second. Two questions of
   * one fan to one creator claimed at once take turns on the lock, and the
   * second counts the first's claim (committed with its transaction).
   * Database only; nothing is recorded when it refuses.
   */
  private async assertNothingWaiting(
    lookup: PayableLookup,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    const draft = await tx.paidDmDraft.findFirst({
      where: { id: lookup.targetId, senderWawuId: lookup.payerWawuUserId },
      select: { id: true, creatorWawuId: true },
    });
    // No such question: `resolve` has already refused it, or is about to.
    if (!draft) return;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`paid-dm:${lookup.payerWawuUserId}:${draft.creatorWawuId}`}, 0))`;
    if (
      (await this.waiting(
        tx,
        lookup.payerWawuUserId,
        draft.creatorWawuId,
        draft.id,
      )) > 0
    ) {
      throw new MoneyError('question_already_waiting', ALREADY_WAITING);
    }
  }

  /**
   * The payment is confirmed and its price is held. Sends the question to the
   * creator once, or pays the price back when it cannot be sent. Idempotent
   * and safe on two servers at once: the payment's row is locked while it is
   * decided, and the question's reference is unique.
   */
  private async deliver(payment: CompletedPayment): Promise<void> {
    const creatorId = payment.payeeWawuUserId;
    if (!creatorId) {
      throw new Error(
        `Payment ${payment.paymentId} is a question with no creator.`,
      );
    }
    const decided = await this.prisma.$transaction(
      async (
        tx,
      ): Promise<
        | { outcome: 'sent'; created: false }
        | { outcome: 'sent'; created: true; amount: number; id: string }
        | { outcome: 'refund'; why: string }
      > => {
        await tx.$queryRaw`SELECT "id" FROM "WalletPayment" WHERE "id" = ${payment.paymentId} FOR UPDATE`;
        const sent = await tx.directMessage.findUnique({
          where: { flutterwaveTxRef: walletDmTxRef(payment.paymentId) },
          select: { id: true },
        });
        if (sent) return { outcome: 'sent', created: false };
        const hold = await tx.walletHold.findUnique({
          where: { paymentId: payment.paymentId },
          select: { action: true },
        });
        if (hold?.action) return { outcome: 'refund', why: 'already decided' };
        const draft = await tx.paidDmDraft.findUnique({
          where: { id: payment.targetId },
        });
        if (
          !draft ||
          draft.senderWawuId !== payment.payerWawuUserId ||
          draft.creatorWawuId !== creatorId
        ) {
          return { outcome: 'refund', why: 'the question is gone' };
        }
        const taken = await tx.directMessage.findUnique({
          where: { id: draft.id },
          select: { id: true },
        });
        if (taken) {
          return {
            outcome: 'refund',
            why: 'another payment already sent this question',
          };
        }
        const why = await this.refusal(tx, draft);
        if (why) return { outcome: 'refund', why };
        const sentAt = new Date();
        const amount = payment.priceKobo / KOBO_PER_NAIRA;
        await tx.directMessage.create({
          data: {
            id: draft.id,
            creatorWawuId: draft.creatorWawuId,
            senderWawuId: draft.senderWawuId,
            text: draft.text,
            amount,
            status: 'awaiting_response',
            sentAt,
            deadlineAt: deadlineOf(sentAt, draft.responseWindowHours),
            respondedAt: null,
            responseText: null,
            flutterwaveTxRef: walletDmTxRef(payment.paymentId),
            flutterwaveTxId: null,
            responseWindowHours: draft.responseWindowHours,
          },
        });
        return { outcome: 'sent', created: true, amount, id: draft.id };
      },
    );
    if (decided.outcome === 'refund') {
      this.logger.warn(
        `payment ${payment.paymentId}: the question could not be sent (${decided.why}); the payment is going back`,
      );
      if (decided.why !== 'already decided') {
        await this.refundWhole(payment.paymentId, decided.why);
      }
      return;
    }
    if (decided.created) {
      try {
        await this.notifications.emit({
          kind: 'dm_received',
          userWawuId: creatorId,
          amount: decided.amount,
          about: {
            target: { kind: 'paid_question', id: decided.id },
            actorWawuId: payment.payerWawuUserId,
          },
        });
      } catch (e) {
        // The question is sent and paid for; a missed notification is not a reason to hold it.
        this.logger.error(
          `payment ${payment.paymentId}: the new question notice failed (${e instanceof Error ? e.name : 'error'})`,
        );
      }
    }
  }

  /** Why the creator cannot be asked right now, or null when they can. Reads only. */
  private async refusal(
    tx: Prisma.TransactionClient,
    draft: PaidDmDraft,
  ): Promise<string | null> {
    const profile = await tx.userProfile.findUnique({
      where: { wawuUserId: draft.creatorWawuId },
      select: { wawuUserId: true },
    });
    if (!profile) return 'the creator is gone';
    const state = await tx.creatorState.findUnique({
      where: { wawuUserId: draft.creatorWawuId },
      select: { dmEnabled: true, dmPrice: true },
    });
    if (!state?.dmEnabled || state.dmPrice == null) {
      return 'the creator switched paid messages off';
    }
    if (
      await this.blocked.isBlockedEitherWay(
        draft.senderWawuId,
        draft.creatorWawuId,
      )
    ) {
      return 'the creator and the payer are blocked';
    }
    try {
      await this.pause.assertAccepting(draft.creatorWawuId);
    } catch (e) {
      if (e instanceof ForbiddenException) {
        return 'the creator is not taking paid messages for now';
      }
      throw e;
    }
    return null;
  }

  /** Pays a payment back whole (the price and everything it took): asked of the hold, holding nothing. */
  private async refundWhole(paymentId: string, why: string): Promise<void> {
    try {
      await this.holds.refund(
        { paymentId },
        `${UNDELIVERED_REASON}: ${why}`.slice(0, 200),
        { returnCharge: true },
      );
    } catch (e) {
      if (e instanceof HoldRequestError) {
        this.logger.error(
          `payment ${paymentId}: its refund was asked and the hold said ${e.code}; a person looks`,
        );
        return;
      }
      throw e;
    }
  }

  // -------------------------------------------------------------------------
  // The creator answers; the window passes
  // -------------------------------------------------------------------------

  /**
   * The creator answered (after the answer is committed): the hold's release
   * pays their 85% (R-5), or keeps it for the wallet they have not opened
   * (R-11). Safe to ask again; a hold already refunded is a defect for a
   * person, never paid out.
   */
  async release(message: {
    id: string;
    flutterwaveTxRef: string;
  }): Promise<void> {
    const paymentId = paymentIdOfTxRef(message.flutterwaveTxRef);
    if (!paymentId) return;
    try {
      await this.holds.release({ paymentId }, ANSWERED_REASON, {
        asEarning: true,
      });
    } catch (e) {
      if (e instanceof HoldRequestError) {
        this.logger.error(
          `question ${message.id}: answered, but its hold said ${e.code}; a person looks`,
        );
        return;
      }
      throw e;
    }
  }

  /**
   * Every minute: questions whose window passed unanswered are refunded
   * through their hold; answered questions whose release was not asked yet
   * (the reply's own ask did not finish) are released; refunds the provider
   * confirmed are told to the payer; abandoned drafts are removed.
   */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'paid-dm-wallet' })
  async sweep(now = new Date()): Promise<PaidDmWalletSweepCounts> {
    const counts: PaidDmWalletSweepCounts = {
      expired: 0,
      released: 0,
      refundsSettled: 0,
      draftsRemoved: 0,
    };
    if (this.sweeping) return counts;
    this.sweeping = true;
    try {
      counts.expired = await this.expire(now);
      counts.released = await this.releaseAnswered();
      counts.refundsSettled = await this.settleRefunds();
      counts.draftsRemoved = await this.removeDrafts(now);
    } catch (e) {
      this.logger.error(
        `paid questions sweep failed (${e instanceof Error ? e.name : 'error'})`,
      );
    } finally {
      this.sweeping = false;
    }
    return counts;
  }

  /** Questions past their window with no answer: flipped to `refunded` by one conditional write, then their hold is refunded. */
  private async expire(now: Date): Promise<number> {
    const due = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT d."id" FROM "DirectMessage" d
        JOIN "WalletHold" h ON h."paymentId" = substr(d."flutterwaveTxRef", 8)
       WHERE d."flutterwaveTxRef" LIKE 'wallet:%'
         AND d."status" = 'awaiting_response' AND d."deadlineAt" < ${now}
         AND h."provider" = ${this.provider.name}
       ORDER BY d."deadlineAt" ASC, d."id" ASC
       LIMIT ${SWEEP_PAGE}`);
    if (due.length === 0) return 0;
    // The conditional write is the whole decision: a reply that committed
    // first left the question `responded` and this matches nothing; the
    // reply's own check (status and deadline in its WHERE) is the other half.
    const { count } = await this.prisma.directMessage.updateMany({
      where: {
        id: { in: due.map((d) => d.id) },
        status: 'awaiting_response',
        deadlineAt: { lt: now },
      },
      data: { status: 'refunded', refundStatus: 'submitted' },
    });
    if (count > 0) {
      this.logger.log(`${count} paid question(s) expired unanswered`);
    }
    return count;
  }

  /** Answered questions whose hold has no outcome yet: ask the release. */
  private async releaseAnswered(): Promise<number> {
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; ref: string }>
    >(Prisma.sql`
      SELECT d."id", d."flutterwaveTxRef" AS "ref" FROM "DirectMessage" d
        JOIN "WalletHold" h ON h."paymentId" = substr(d."flutterwaveTxRef", 8)
       WHERE d."flutterwaveTxRef" LIKE 'wallet:%'
         AND d."status" = 'responded'
         AND h."status" = 'held' AND h."action" IS NULL
         AND h."provider" = ${this.provider.name}
       ORDER BY d."respondedAt" ASC, d."id" ASC
       LIMIT ${SWEEP_PAGE}`);
    let done = 0;
    for (const r of rows) {
      try {
        await this.release({ id: r.id, flutterwaveTxRef: r.ref });
        done += 1;
      } catch (e) {
        this.logger.error(
          `question ${r.id}: its release could not be asked (${e instanceof Error ? e.name : 'error'}); the next pass asks again`,
        );
      }
    }
    return done;
  }

  /** Expired questions: ask the refund while the hold has no outcome, tell the payer once the provider confirmed it. */
  private async settleRefunds(): Promise<number> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        ref: string;
        sender: string;
        amount: number;
        action: string | null;
        holdStatus: string;
        settledAt: Date | null;
      }>
    >(Prisma.sql`
      SELECT d."id", d."flutterwaveTxRef" AS "ref", d."senderWawuId" AS "sender",
             d."amount", h."action", h."status" AS "holdStatus", h."settledAt"
        FROM "DirectMessage" d
        JOIN "WalletHold" h ON h."paymentId" = substr(d."flutterwaveTxRef", 8)
       WHERE d."flutterwaveTxRef" LIKE 'wallet:%'
         AND d."status" = 'refunded' AND d."refundStatus" = 'submitted'
         AND h."provider" = ${this.provider.name}
       ORDER BY d."deadlineAt" ASC, d."id" ASC
       LIMIT ${SWEEP_PAGE}`);
    let told = 0;
    for (const r of rows) {
      try {
        let confirmed = r.holdStatus === 'refunded';
        if (!confirmed && r.action === null) {
          const paymentId = paymentIdOfTxRef(r.ref)!;
          try {
            // The fan did not cause this: every naira comes back, the
            // payment's charge included, and WAWU bears the refund's own
            // charge (lead ruling 17 Oct 2026, as Q-03 and EVENTS-10).
            const settlement = await this.holds.refund(
              { paymentId },
              UNANSWERED_REASON,
              { returnCharge: true },
            );
            confirmed = settlement.status === 'refunded';
          } catch (e) {
            if (!(e instanceof HoldRequestError)) throw e;
            this.logger.error(
              `question ${r.id}: its window passed, but its hold said ${e.code}; a person looks`,
            );
          }
        }
        if (!confirmed) continue;
        const { count } = await this.prisma.directMessage.updateMany({
          where: { id: r.id, refundStatus: 'submitted' },
          data: {
            refundStatus: 'settled',
            refundedAt: r.settledAt ?? new Date(),
          },
        });
        // Only the caller that wrote the mark tells the payer.
        if (count === 1) {
          told += 1;
          await this.notifications
            .emit({
              kind: 'dm_refunded',
              userWawuId: r.sender,
              amount: r.amount,
            })
            .catch((e: unknown) => {
              this.logger.error(
                `question ${r.id}: the refund notice failed (${e instanceof Error ? e.name : 'error'})`,
              );
            });
        }
      } catch (e) {
        this.logger.error(
          `question ${r.id}: its refund could not be settled (${e instanceof Error ? e.name : 'error'}); the next pass looks again`,
        );
      }
    }
    return told;
  }

  /** Drafts nobody ever paid for, older than the keep time. */
  private async removeDrafts(now: Date): Promise<number> {
    const before = new Date(now.getTime() - DRAFT_KEEP_DAYS * 86_400_000);
    return this.prisma.$executeRaw`
      DELETE FROM "PaidDmDraft" d
       WHERE d."createdAt" < ${before}
         AND NOT EXISTS (SELECT 1 FROM "WalletPayment" p
                          WHERE p."kind" = ${PAID_DM_KIND} AND p."targetId" = d."id")
         AND NOT EXISTS (SELECT 1 FROM "DirectMessage" m WHERE m."id" = d."id")`;
  }

  // -------------------------------------------------------------------------
  // Rules that read the database
  // -------------------------------------------------------------------------

  /**
   * The creator's price and window when the fan may ask them now, else the
   * refusal. `exceptDraftId` is the question being paid (it never counts as
   * the one that is waiting).
   */
  private async askable(
    db: Db,
    senderWawuId: string,
    creatorWawuId: string,
    exceptDraftId?: string,
  ): Promise<{ priceKobo: number; responseWindowHours: number }> {
    if (creatorWawuId === senderWawuId) {
      throw new MoneyError('target_not_payable', OWN_QUESTION);
    }
    const state = await db.creatorState.findUnique({
      where: { wawuUserId: creatorWawuId },
      select: { dmPrice: true, dmEnabled: true, dmResponseHours: true },
    });
    const profile = await db.userProfile.findUnique({
      where: { wawuUserId: creatorWawuId },
      select: { wawuUserId: true },
    });
    if (!state || !profile) {
      throw new MoneyError('target_not_found', CREATOR_NOT_FOUND);
    }
    if (!state.dmEnabled || state.dmPrice == null) {
      throw new MoneyError('target_not_payable', NOT_ACCEPTING);
    }
    if (await this.blocked.isBlockedEitherWay(senderWawuId, creatorWawuId)) {
      throw new MoneyError('target_not_payable', BLOCKED_MESSAGE);
    }
    try {
      await this.pause.assertAccepting(creatorWawuId);
    } catch (e) {
      if (e instanceof ForbiddenException) {
        throw new MoneyError('target_not_payable', PAUSED_MESSAGE);
      }
      throw e;
    }
    if (
      (await this.waiting(db, senderWawuId, creatorWawuId, exceptDraftId)) > 0
    ) {
      throw new MoneyError('question_already_waiting', ALREADY_WAITING);
    }
    return {
      priceKobo: state.dmPrice * KOBO_PER_NAIRA,
      responseWindowHours: state.dmResponseHours ?? 24,
    };
  }

  /**
   * How many questions of this fan are waiting on this creator: sent and not
   * yet answered or refunded (a web question counts too), plus payments for
   * another question still being confirmed or delivered.
   */
  private async waiting(
    db: Db,
    senderWawuId: string,
    creatorWawuId: string,
    exceptDraftId?: string,
  ): Promise<number> {
    const [sent, paying] = await Promise.all([
      db.directMessage.count({
        where: {
          senderWawuId,
          creatorWawuId,
          status: 'awaiting_response',
          ...(exceptDraftId ? { id: { not: exceptDraftId } } : {}),
        },
      }),
      db.walletPayment.count({
        where: {
          kind: PAID_DM_KIND,
          payerWawuUserId: senderWawuId,
          payeeWawuUserId: creatorWawuId,
          ...(exceptDraftId ? { targetId: { not: exceptDraftId } } : {}),
          OR: [
            { status: 'pending' },
            { status: 'completed', fulfilledAt: null },
          ],
        },
      }),
    ]);
    return sent + paying;
  }

  /** A draft made under this key by this fan: the same question answers it, another is a reuse. */
  private async sameKey(
    senderWawuId: string,
    key: string,
    creatorWawuId: string,
    text: string,
  ): Promise<PaidDmDraft | null> {
    const existing = await this.prisma.paidDmDraft.findUnique({
      where: { senderWawuId_requestKey: { senderWawuId, requestKey: key } },
    });
    if (!existing) return null;
    if (existing.creatorWawuId !== creatorWawuId || existing.text !== text) {
      throw new MoneyError('idempotency_key_reused', KEY_REUSED);
    }
    return existing;
  }

  /** A draft the caller made, or the same 404 an id nobody holds gets. */
  private async owned(wawuUserId: string, id: string): Promise<PaidDmDraft> {
    const draft = await this.prisma.paidDmDraft.findFirst({
      where: { id, senderWawuId: wawuUserId },
    });
    if (!draft) throw new MoneyError('target_not_found', QUESTION_NOT_FOUND);
    return draft;
  }

  // -------------------------------------------------------------------------
  // What the routes answer
  // -------------------------------------------------------------------------

  private async quoteOf(
    wallet: OpenWallet,
    draft: PaidDmDraft,
  ): Promise<PaidQuestionQuoteView> {
    const payment = await this.payments.quote(wallet, {
      kind: PAID_DM_KIND,
      targetId: draft.id,
    });
    // The same median PROS-02's card and H10 read (G-146): replies to wallet
    // questions are stamped `respondedAt` on the same `DirectMessage` rows.
    const reply = (await replyTimesFor(this.prisma, [draft.creatorWawuId])).get(
      draft.creatorWawuId,
    );
    return {
      question: {
        id: draft.id,
        creator: payment.payee,
        text: draft.text,
        priceKobo: payment.priceKobo,
        replyWindowHours: draft.responseWindowHours,
        usualReplyMinutes: reply?.usualReplyMinutes ?? null,
      } satisfies PaidQuestionDraftView,
      payment,
    };
  }

  /** The question a payment is for, as the pay route answers and the key stores it. */
  async present(view: PaymentView): Promise<PaidQuestionWalletView> {
    if (view.kind !== PAID_DM_KIND) {
      throw new Error(`Payment ${view.id} is not a paid question payment.`);
    }
    const draft = await this.prisma.paidDmDraft.findUniqueOrThrow({
      where: { id: view.targetId },
    });
    return this.build(draft, view);
  }

  private async party(id: string): Promise<MoneyPartyView | null> {
    try {
      return (
        (await loadMoneyParties(this.prisma, this.wawuId, [id])).get(id) ?? null
      );
    } catch {
      // A name is never worth a failed answer.
      return null;
    }
  }

  private async build(
    draft: PaidDmDraft,
    payment: PaymentView | null,
  ): Promise<PaidQuestionWalletView> {
    const sent = payment
      ? await this.prisma.directMessage.findUnique({
          where: { flutterwaveTxRef: walletDmTxRef(payment.id) },
          select: {
            status: true,
            refundStatus: true,
            sentAt: true,
            deadlineAt: true,
          },
        })
      : null;
    const decision =
      payment && !sent
        ? await this.prisma.walletHold.findUnique({
            where: { paymentId: payment.id },
            select: { action: true, status: true },
          })
        : null;
    let status: PaidQuestionStatus;
    let statusMessage: string | null = null;
    if (sent) {
      if (sent.status === 'awaiting_response') {
        status = 'asked';
        statusMessage = 'Held by WAWU until they answer.';
      } else if (sent.status === 'responded') {
        status = 'answered';
        statusMessage = 'They answered, so they have been paid.';
      } else if (sent.refundStatus === 'settled') {
        status = 'refunded';
        statusMessage =
          'No reply in time, so your money is back in your wallet.';
      } else {
        status = 'refunding';
        statusMessage = 'No reply in time, so your money is on its way back.';
      }
    } else if (!payment) {
      status = 'unpaid';
    } else if (decision?.action === 'refund') {
      status = decision.status === 'refunded' ? 'refunded' : 'refunding';
      statusMessage =
        'This question could not be sent, so your money is on its way back.';
    } else if (payment.status === 'failed') {
      status = 'failed';
      statusMessage = payment.failureReason ?? payment.statusMessage;
    } else if (payment.status === 'reversed') {
      status = 'reversed';
      statusMessage = payment.statusMessage;
    } else {
      status = 'pending';
      statusMessage = payment.statusMessage;
    }
    const state = payment
      ? null
      : await this.prisma.creatorState.findUnique({
          where: { wawuUserId: draft.creatorWawuId },
          select: { dmPrice: true },
        });
    return {
      id: draft.id,
      method: 'wallet',
      status,
      statusMessage,
      creator: await this.party(draft.creatorWawuId),
      text: draft.text,
      priceKobo: payment
        ? payment.priceKobo
        : (state?.dmPrice ?? 0) * KOBO_PER_NAIRA,
      replyWindowHours: draft.responseWindowHours,
      deadlineAt: sent ? sent.deadlineAt.toISOString() : null,
      payment,
      createdAt: draft.createdAt.toISOString(),
      sentAt: sent ? sent.sentAt.toISOString() : null,
    };
  }
}
