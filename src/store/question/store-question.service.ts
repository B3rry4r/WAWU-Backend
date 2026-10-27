import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '../../../generated/prisma/client';
import type {
  DirectMessage,
  StorePurchase,
  StorePurchaseIntent,
} from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { DmAnsweredHooks } from '../../direct-message/dm-answered-hooks';
import {
  purchaseIdOfStoreRef,
  STORE_REFUND_MARK,
  storeQuestionRef,
} from '../../direct-message/store-question-ref';
import { deadlineOf } from '../../direct-message/wallet/paid-dm-wallet-rules';
import { NotificationService } from '../../notification/notification.service';
import { StoreSaleNoticeService } from '../notice/store-sale-notice.service';
import { StoreEarningService } from '../store-earning.service';
import {
  QUESTION_CREDIT_SCOPE,
  QUESTION_EARNING_TITLE,
} from './store-question-rules';
import { StoreQuestionTargetService } from './store-question-target.service';

/** Rows one pass of the sweep reads for each of its steps. */
const SWEEP_PAGE = 100;

/** What the sweep did, for logs and tests. */
export interface StoreQuestionSweepCounts {
  /** Questions whose deadline passed unanswered: the asker was given a question credit. */
  expired: number;
  /** Answered questions whose earning had not been recorded yet and now is. */
  earned: number;
}

type Db = Prisma.TransactionClient;

/**
 * A paid question bought in a store (STORE-QUESTION, R-101 points 2, 4, 5, 6).
 *
 * - **Sent when the sale is verified** (`deliver`, called by the ladder's grant
 *   inside its transaction): a `DirectMessage` exactly as the wallet path writes
 *   one, awaiting the creator's reply until `sentAt` plus the creator's reply
 *   window as the asker was shown it (`deadlineOf`, the wallet path's own rule).
 *   Its reference is `store:<StorePurchase id>`. The money is a store sale: it
 *   is in no wallet and in no hold.
 * - **Answered in time** (`onAnswered`, after the reply commits, and the sweep
 *   for any the hook did not finish): the creator's 85% of the LIST price
 *   becomes a `StoreEarning`, payable 3 working days from the ANSWER, and the
 *   creator is told once (STORE-SALE-NOTICE).
 * - **Not answered by the deadline** (`sweep`): no earning. The asker gets a
 *   question credit worth the list price (`StoreCredit` with scope
 *   `question`), never cash, and is told once. One conditional write on the
 *   question decides it, the reply's own write being the other half, so a
 *   reply and the deadline cannot both win.
 * - **Store refund** (`cancel`, `reopen`, called by the grant's take-back): a
 *   refund before the answer withdraws the question; after the answer the
 *   earning is taken back as for any ladder sale.
 *
 * Every decision about one purchase is made under the purchase's advisory lock
 * (the same one the grant and the refund take), so an answer, the deadline, a
 * refund and a replay take turns.
 */
@Injectable()
export class StoreQuestionService implements OnModuleInit {
  private readonly logger = new Logger(StoreQuestionService.name);
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly earnings: StoreEarningService,
    private readonly notices: StoreSaleNoticeService,
    private readonly notifications: NotificationService,
    private readonly target: StoreQuestionTargetService,
    private readonly answered: DmAnsweredHooks,
  ) {}

  onModuleInit(): void {
    this.answered.register((message) => this.onAnswered(message));
  }

  // -------------------------------------------------------------------------
  // The sale: the question is sent
  // -------------------------------------------------------------------------

  /**
   * Sends the question a verified sale bought, inside the grant's transaction.
   * Returns the question's id (the intent's id), or null when it cannot be sent
   * right now (the person already has a question waiting on this creator): the
   * caller then credits the payment. The creator is told of the new question
   * in the same transaction.
   */
  async deliver(
    tx: Db,
    purchase: StorePurchase,
    intent: StorePurchaseIntent,
    now: Date,
  ): Promise<string | null> {
    const asker = purchase.wawuUserId;
    const creator = intent.targetId;
    if (
      asker === null ||
      intent.questionText === null ||
      intent.questionWindowHours === null
    )
      return null;
    // The wallet path's own lock for this person and creator: a question of
    // each path cannot be sent at once.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`paid-dm:${asker}:${creator}`}, 0))`;
    if ((await this.target.waiting(tx, asker, creator)) > 0) return null;
    await tx.directMessage.create({
      data: {
        id: intent.id,
        creatorWawuId: creator,
        senderWawuId: asker,
        text: intent.questionText,
        amount: intent.listPriceNaira,
        status: 'awaiting_response',
        sentAt: now,
        deadlineAt: deadlineOf(now, intent.questionWindowHours),
        respondedAt: null,
        responseText: null,
        flutterwaveTxRef: storeQuestionRef(purchase.id),
        flutterwaveTxId: null,
        responseWindowHours: intent.questionWindowHours,
      },
    });
    // The words now live on the message.
    await tx.storePurchaseIntent.update({
      where: { id: intent.id },
      data: { questionText: null },
    });
    await this.notifications.emitOrThrow(
      {
        kind: 'dm_received',
        userWawuId: creator,
        amount: intent.listPriceNaira,
        // The words say an unanswered question gives the asker a question credit.
        storeQuestion: true,
        replyHours: intent.questionWindowHours,
        about: {
          target: { kind: 'paid_question', id: intent.id },
          actorWawuId: asker,
        },
      },
      tx,
    );
    return intent.id;
  }

  // -------------------------------------------------------------------------
  // The creator answers
  // -------------------------------------------------------------------------

  /**
   * The creator answered (after the reply is committed): records their 85% as
   * an earning payable 3 working days from the answer, and tells them, once.
   * Safe to run again: the earning is the once-only gate. A purchase the store
   * has since paid back earns nothing.
   */
  async onAnswered(message: {
    id: string;
    flutterwaveTxRef: string;
  }): Promise<void> {
    const purchaseId = purchaseIdOfStoreRef(message.flutterwaveTxRef);
    if (purchaseId === null) return;
    const found = await this.prisma.storePurchase.findUnique({
      where: { id: purchaseId },
    });
    if (found === null) return;
    await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, found);
      const purchase = await tx.storePurchase.findUnique({
        where: { id: purchaseId },
      });
      if (purchase === null || purchase.status !== 'granted') return;
      const dm = await tx.directMessage.findUnique({
        where: { id: message.id },
      });
      if (
        dm === null ||
        dm.status !== 'responded' ||
        dm.flutterwaveTxRef !== message.flutterwaveTxRef
      )
        return;
      const have = await tx.storeEarning.findUnique({
        where: {
          storePurchaseId_role: { storePurchaseId: purchase.id, role: 'sale' },
        },
        select: { id: true },
      });
      if (have !== null) return;
      const listPriceKobo = purchase.referenceKobo ?? dm.amount * 100;
      await this.earnings.record(tx, {
        purchase,
        payeeWawuUserId: dm.creatorWawuId,
        buyKind: 'question',
        targetId: dm.id,
        title: QUESTION_EARNING_TITLE,
        listPriceKobo,
        soldAt: purchase.purchasedAt,
        // Earned when answered, so 3 working days count from the answer.
        earnedAt: dm.respondedAt ?? new Date(),
      });
      await this.notices.told(tx, {
        kind: 'question',
        creatorWawuId: dm.creatorWawuId,
        buyerWawuId: purchase.wawuUserId,
        targetId: dm.id,
        title: QUESTION_EARNING_TITLE,
        listPriceKobo,
      });
    });
  }

  // -------------------------------------------------------------------------
  // The deadline
  // -------------------------------------------------------------------------

  /** Every minute: unanswered questions past their deadline give the asker a question credit; answered ones whose earning is not recorded yet are recorded. */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'store-questions' })
  async sweep(now = new Date()): Promise<StoreQuestionSweepCounts> {
    const counts: StoreQuestionSweepCounts = { expired: 0, earned: 0 };
    if (this.sweeping) return counts;
    this.sweeping = true;
    try {
      counts.expired = await this.expireDue(now);
      counts.earned = await this.recordAnswered();
    } catch (e) {
      this.logger.error(
        `store questions sweep failed (${e instanceof Error ? e.name : 'error'})`,
      );
    } finally {
      this.sweeping = false;
    }
    return counts;
  }

  private async expireDue(now: Date): Promise<number> {
    const due = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT d."id" FROM "DirectMessage" d
       WHERE d."flutterwaveTxRef" LIKE 'store:%'
         AND d."status" = 'awaiting_response' AND d."deadlineAt" < ${now}
       ORDER BY d."deadlineAt" ASC, d."id" ASC
       LIMIT ${SWEEP_PAGE}`);
    let done = 0;
    for (const { id } of due) {
      try {
        if (await this.expireOne(id, now)) done += 1;
      } catch (e) {
        this.logger.error(
          `question ${id}: its deadline could not be settled (${e instanceof Error ? e.name : 'error'}); the next pass looks again`,
        );
      }
    }
    return done;
  }

  private async expireOne(dmId: string, now: Date): Promise<boolean> {
    const dm = await this.prisma.directMessage.findUnique({
      where: { id: dmId },
    });
    const purchaseId = dm ? purchaseIdOfStoreRef(dm.flutterwaveTxRef) : null;
    if (dm === null || purchaseId === null) return false;
    const found = await this.prisma.storePurchase.findUnique({
      where: { id: purchaseId },
    });
    if (found === null) return false;
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx, found);
      const purchase = await tx.storePurchase.findUnique({
        where: { id: purchaseId },
      });
      if (purchase === null || purchase.status !== 'granted') return false;
      // The whole decision: a reply that committed first left the question
      // `responded` and this matches nothing; the reply's own check (status and
      // deadline in its WHERE) is the other half.
      const { count } = await tx.directMessage.updateMany({
        where: {
          id: dmId,
          status: 'awaiting_response',
          deadlineAt: { lt: now },
        },
        data: { status: 'refunded', refundStatus: 'settled', refundedAt: now },
      });
      if (count === 0) return false;
      await this.creditUnanswered(tx, purchase, dm, now);
      return true;
    });
  }

  /**
   * The asker's question credit for a question nobody answered: worth the list
   * price, scope `question`, one per purchase (the source is the purchase). It
   * carries the origin of the money, so a store refund of the original payment
   * voids it, or takes back what it paid for. Told once, here.
   */
  private async creditUnanswered(
    tx: Db,
    purchase: StorePurchase,
    dm: DirectMessage,
    now: Date,
    countsAsMiss = true,
  ): Promise<void> {
    const asker = purchase.wawuUserId;
    // The asker's account is gone: there is no one to credit.
    if (asker === null) return;
    const amountKobo = purchase.referenceKobo ?? dm.amount * 100;
    const { count } = await tx.storeCredit.createMany({
      data: [
        {
          wawuUserId: asker,
          amountKobo,
          sourcePurchaseId: purchase.id,
          originPurchaseId: purchase.creditOriginId ?? purchase.id,
          scope: QUESTION_CREDIT_SCOPE,
        },
      ],
      skipDuplicates: true,
    });
    const credit = await tx.storeCredit.findUniqueOrThrow({
      where: { sourcePurchaseId: purchase.id },
      select: { id: true },
    });
    await tx.directMessage.update({
      where: { id: dm.id },
      data: {
        // A question a refund withdrew keeps its mark, so it stays out of the creator's standing.
        ...(countsAsMiss
          ? { refundReference: `store_credit:${credit.id}` }
          : {}),
        refundedAt: now,
      },
    });
    // The asker is told once. A question a refund withdrew did not go unanswered,
    // so the notice's words ("did not reply in time") would be false: none is sent.
    if (count > 0 && countsAsMiss)
      await this.notifications.emitOrThrow(
        {
          kind: 'question_credit',
          userWawuId: asker,
          amount: amountKobo / 100,
          about: {
            target: { kind: 'paid_question', id: dm.id },
            actorWawuId: dm.creatorWawuId,
          },
        },
        tx,
      );
  }

  /** Answered questions whose earning is not there yet (the answer's own step did not finish): record each. */
  private async recordAnswered(): Promise<number> {
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; ref: string }>
    >(Prisma.sql`
      SELECT d."id", d."flutterwaveTxRef" AS "ref" FROM "DirectMessage" d
        JOIN "StorePurchase" p ON p."id" = substr(d."flutterwaveTxRef", 7)
       WHERE d."flutterwaveTxRef" LIKE 'store:%'
         AND d."status" = 'responded' AND p."status" = 'granted'
         AND NOT EXISTS (SELECT 1 FROM "StoreEarning" e
                          WHERE e."storePurchaseId" = p."id" AND e."role" = 'sale')
       ORDER BY d."respondedAt" ASC, d."id" ASC
       LIMIT ${SWEEP_PAGE}`);
    let done = 0;
    for (const r of rows) {
      try {
        await this.onAnswered({ id: r.id, flutterwaveTxRef: r.ref });
        done += 1;
      } catch (e) {
        this.logger.error(
          `question ${r.id}: its earning could not be recorded (${e instanceof Error ? e.name : 'error'}); the next pass looks again`,
        );
      }
    }
    return done;
  }

  // -------------------------------------------------------------------------
  // A store refund
  // -------------------------------------------------------------------------

  /**
   * The store paid the asker back (inside the take-back's transaction): a
   * question not yet answered is withdrawn and marked, so the creator's standing
   * does not count it as a miss. One already answered keeps its answer; its
   * earning is taken back by the caller. One already settled as unanswered
   * keeps that: its credit is voided by the caller.
   */
  async cancel(
    tx: Db,
    purchase: Pick<StorePurchase, 'id'>,
    now: Date,
  ): Promise<{ question: 'withdrawn' | 'answered' | 'unanswered' | 'none' }> {
    const ref = storeQuestionRef(purchase.id);
    const { count } = await tx.directMessage.updateMany({
      where: { flutterwaveTxRef: ref, status: 'awaiting_response' },
      data: {
        status: 'refunded',
        refundStatus: 'settled',
        refundedAt: now,
        refundReference: STORE_REFUND_MARK,
      },
    });
    if (count > 0) return { question: 'withdrawn' };
    const dm = await tx.directMessage.findUnique({
      where: { flutterwaveTxRef: ref },
      select: { status: true },
    });
    if (dm === null) return { question: 'none' };
    return { question: dm.status === 'responded' ? 'answered' : 'unanswered' };
  }

  /**
   * Apple reversed its refund (inside the restore's transaction): a question the
   * refund withdrew is open again if its deadline has not passed; if it has, it
   * is an unanswered question and the asker is credited.
   */
  async reopen(
    tx: Db,
    purchase: StorePurchase,
    now: Date,
  ): Promise<{
    question: 'reopened' | 'credited' | 'unanswered' | 'unchanged' | 'none';
  }> {
    const dm = await tx.directMessage.findUnique({
      where: { flutterwaveTxRef: storeQuestionRef(purchase.id) },
    });
    if (dm === null) return { question: 'none' };
    if (dm.status !== 'refunded' || dm.refundReference !== STORE_REFUND_MARK)
      return { question: 'unchanged' };
    if (dm.deadlineAt.getTime() > now.getTime()) {
      // The person has asked this creator again since the refund: one question
      // waits per creator (G-75), so the reversal gives a question credit instead
      // of a second waiting question. The creator did nothing, so it is no miss.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`paid-dm:${dm.senderWawuId}:${dm.creatorWawuId}`}, 0))`;
      if (
        (await this.target.waiting(tx, dm.senderWawuId, dm.creatorWawuId)) > 0
      ) {
        await this.creditUnanswered(tx, purchase, dm, now, false);
        return { question: 'credited' };
      }
      await tx.directMessage.update({
        where: { id: dm.id },
        data: {
          status: 'awaiting_response',
          refundStatus: 'not_owed',
          refundedAt: null,
          refundReference: null,
        },
      });
      return { question: 'reopened' };
    }
    await this.creditUnanswered(tx, purchase, dm, now);
    return { question: 'unanswered' };
  }

  /** The asker's words are no longer needed once the sale is settled as a credit instead of a sent question: they are cleared from the intent. */
  async clearWords(tx: Db, intentId: string): Promise<void> {
    await tx.storePurchaseIntent.updateMany({
      where: { id: intentId, questionText: { not: null } },
      data: { questionText: null },
    });
  }

  /** The lock a grant, a refund and every decision about one store transaction take. */
  private async lock(tx: Db, purchase: StorePurchase): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`store-purchase:${purchase.platform}:${purchase.storeTransactionId}`}, 0))`;
  }
}
