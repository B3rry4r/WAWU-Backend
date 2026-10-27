import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type {
  Prisma,
  PlanTransferOrder,
} from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WalletGate, type OpenWallet } from '../../money/gate/wallet-gate';
import { MONEY_IN_CATEGORIES } from '../../money/money-in-notice/money-in-notice-config';
import { MoneyError } from '../../money/money-error';
import type { FeeQuoteView, PaymentView } from '../../money/money-view.type';
import {
  bodyFingerprint,
  IdempotencyService,
  type IdempotencyScope,
} from '../../money/payments/idempotency';
import type { PayableTarget } from '../../money/payments/payable-registry';
import {
  openKeyOf,
  STILL_CONFIRMING_MESSAGE,
  successBody,
  WalletPaymentService,
} from '../../money/payments/wallet-payment.service';
import { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import { rowsOf } from '../../wallet-provider/provider-rows';
import {
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import {
  backoffMs,
  duePeople,
  HOUR_MS,
  lapsed,
  MINUTE_MS,
  EXPIRED_MESSAGE,
  LIMIT_WAITING_MESSAGE,
  NO_WALLET_ANY_MORE_MESSAGE,
  NOT_PAYABLE_ANY_MORE_MESSAGE,
  ORDER_STATUS,
  orderOpenKey,
  PAID_ANOTHER_WAY_MESSAGE,
  PAYMENT_FAILED_WAITING_MESSAGE,
  QUOTE_CHANGED_MESSAGE,
  REPLACED_MESSAGE,
  sameQuote,
  settleKeyOf,
  TRANSFER_DEFAULTS,
} from './plan-transfer-order';
import {
  PLAN_PURCHASE_ROUTE,
  PURCHASE_PAYMENT_KINDS,
  type PurchasePaymentKind,
} from './plan-purchase-terms';

type Tx = Prisma.TransactionClient;

/** The setting that sets how long a transfer purchase waits (admin settings, TIER-06). */
export const TRANSFER_WINDOW_SETTING = 'plan.transfer_window_hours';

/** What one pass of the settlement did. */
export interface TransferSweepReport {
  expired: number;
  recovered: number;
  paid: number;
  pending: number;
  waiting: number;
  closed: number;
  retry: number;
}

/** What settling one order came to. */
export type SettleOutcome =
  /** A wallet payment completed it. */
  | 'paid'
  /** A wallet payment exists and the provider has not confirmed it yet. */
  | 'pending'
  /** The balance does not cover the total yet; still waiting. */
  | 'waiting'
  /** Closed with nothing taken (not payable any more, the quote changed, paid another way). */
  | 'closed'
  /** Another process holds it, or it is not waiting any more. */
  | 'skipped'
  /** Could not be tried now (the provider, a limit); waiting, tried again later. */
  | 'retry';

/** The few columns of a waiting order the sweep reads to say who is due. */
interface WaitingRow {
  id: string;
  wawuUserId: string;
  createdAt: Date;
  creditsSeenAt: Date | null;
  nextCheckAt: Date | null;
}

/** The errors that end an order: the item cannot be paid for any more. */
const CLOSING_CODES = new Set<string>([
  'target_not_payable',
  'target_not_found',
  'amount_out_of_range',
  // The tier an extra products order was placed on ended while it waited.
  'tier_required',
  // The pack was ruled out while the order waited (PACK-CAP, R-100).
  'pack_not_allowed',
]);

/**
 * Pay by bank transfer at checkout (task TIER-05, VF6 "transfer details
 * shown", PT4; R-42, R-43, R-44).
 *
 * - **An order, not a payment.** `method: transfer` confirms the purchase with
 *   the PIN at one quote (price, Bank charge, total, goods) and writes a
 *   `PlanTransferOrder`. Nothing moves. The person sends money to their own
 *   wallet account number; WAWU runs no collection account (R-42).
 * - **The provider's balance decides.** The sweep reads the provider's
 *   available balance (never a sum of our records) for a person whose wallet
 *   got a new credit, or on a slow recheck. When it covers the total, the
 *   order is paid through the SAME wallet payment as `method: wallet` (MONEY-17,
 *   TIER-03): one payment per order, delivery and grants exactly as there.
 *   Several transfers landing, one landing twice (the ledger folds it), or a
 *   sweep and another server finding it together are all one payment: the
 *   order is taken `awaiting` to `settling` by one conditional write, the
 *   payment is made under the order's own idempotency key, and the wallet
 *   payment's `openKey` allows one open payment per person and item.
 * - **The quote binds.** The order keeps the price, total and goods the PIN
 *   was given for. A current quote that differs (a price, the goods or the
 *   Bank charge changed) closes the order with nothing taken, so the person
 *   is never charged what they did not confirm (TIER-06 round 2).
 * - **Never a lock or a transaction across the network.** The order is
 *   claimed in one short write; the provider is then called holding nothing;
 *   the result is recorded in one short write. A claim that dies is
 *   recovered by the sweep from the order's idempotency key.
 * - **A lapsed window** marks the order `expired`. The money that arrived
 *   stays in the wallet and nothing is taken. An order whose payment was made
 *   but not yet linked (the process died between the two) is linked, never
 *   expired.
 * - **Every waiting order is looked at.** A pass reads all of them (a light
 *   page at a time), asks the ledger once per page of people for their newest
 *   money-in row, and settles the people who are due: a new credit first,
 *   then a recheck that came, oldest order first, within a time budget. An
 *   order it checked is not due again until a new credit or its recheck, so a
 *   crowd of unfunded orders never hides one whose money landed.
 * - **A payment that failed moves nothing** and the order waits again (the
 *   next try later, never two payments: a failed payment is let go of, a
 *   payment in progress or made is linked).
 * - **Oldest first.** One person's waiting orders are settled oldest first,
 *   each only while the balance, read again before each, covers its total.
 * - **Paid another way.** A wallet payment for the same item made after the
 *   order was placed closes the order (its goods were bought once).
 */
@Injectable()
export class PlanTransferService {
  private readonly logger = new Logger(PlanTransferService.name);
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: WalletPaymentService,
    private readonly gate: WalletGate,
    private readonly keys: IdempotencyService,
    private readonly settings: PlanSettingsService,
    @Inject(WALLET_PROVIDER) private readonly provider: WalletProvider,
  ) {}

  // -------------------------------------------------------------------------
  // Placing an order (POST /plans/purchases, method transfer)
  // -------------------------------------------------------------------------

  /** How long a new order waits for the money, from the admin setting. */
  windowMs(): number {
    return this.settings.number(TRANSFER_WINDOW_SETTING) * HOUR_MS;
  }

  /**
   * Writes the order for a purchase the person confirmed at `fee`'s quote.
   * One waiting order per person and item: a second request for the item
   * closes the first, unless the first is being paid (`409
   * payment_in_progress` with its id). Holds the person's lock for the write
   * only; nothing here calls the provider.
   */
  async place(input: {
    wallet: OpenWallet;
    kind: PurchasePaymentKind;
    targetId: string;
    target: PayableTarget;
    fee: FeeQuoteView;
    availableKobo: number;
    now?: Date;
  }): Promise<PlanTransferOrder> {
    const { wallet, kind, targetId, target, fee, availableKobo } = input;
    const now = input.now ?? new Date();
    const payer = wallet.wawuUserId;
    const open = await this.prisma.walletPayment.findUnique({
      where: { openKey: openKeyOf(payer, kind, targetId) },
      select: { id: true },
    });
    if (open)
      throw new MoneyError('payment_in_progress', STILL_CONFIRMING_MESSAGE, {
        paymentId: open.id,
      });
    const openKey = orderOpenKey(payer, kind, targetId);
    return this.prisma.$transaction(async (tx) => {
      await lockPerson(tx, payer);
      const waiting = await tx.planTransferOrder.findUnique({
        where: { openKey },
      });
      if (waiting?.status === ORDER_STATUS.settling)
        throw new MoneyError('payment_in_progress', STILL_CONFIRMING_MESSAGE, {
          paymentId: waiting.id,
        });
      if (waiting)
        await tx.planTransferOrder.update({
          where: { id: waiting.id },
          data: {
            status: ORDER_STATUS.closed,
            openKey: null,
            statusMessage: REPLACED_MESSAGE,
          },
        });
      return tx.planTransferOrder.create({
        data: {
          wawuUserId: payer,
          paymentKind: kind,
          targetId,
          priceKobo: target.priceKobo,
          providerFeeKobo: fee.fee.totalFeeKobo,
          totalKobo: fee.totalKobo,
          ...(target.terms === undefined ? {} : { terms: target.terms }),
          status: ORDER_STATUS.awaiting,
          openKey,
          expiresAt: new Date(now.getTime() + this.windowMs()),
          // A balance that already covers it is paid at the next pass; else the
          // sweep waits for a credit, with a slow recheck as a safety net.
          nextCheckAt:
            availableKobo >= fee.totalKobo
              ? now
              : new Date(now.getTime() + TRANSFER_DEFAULTS.recheckMs),
        },
      });
    });
  }

  /** Stores the answer a repeat of the request's Idempotency-Key gets. */
  async answer(scope: IdempotencyScope, view: unknown): Promise<void> {
    scope.answered = view;
    await this.keys.finish(scope, 201, successBody(view));
  }

  /** One of the person's orders by id, or null. */
  find(wawuUserId: string, id: string): Promise<PlanTransferOrder | null> {
    return this.prisma.planTransferOrder.findFirst({
      where: { id, wawuUserId },
    });
  }

  /** The order a wallet payment paid, or null. */
  byPayment(paymentId: string): Promise<PlanTransferOrder | null> {
    return this.prisma.planTransferOrder.findUnique({ where: { paymentId } });
  }

  /**
   * The person paid the item another way (a wallet purchase): any order still
   * waiting for it closes. Best effort; the settlement checks again before it
   * pays, so a miss here costs nothing.
   */
  async closeWaiting(wawuUserId: string, targetId: string): Promise<void> {
    await this.prisma.planTransferOrder.updateMany({
      where: { wawuUserId, targetId, status: ORDER_STATUS.awaiting },
      data: {
        status: ORDER_STATUS.closed,
        openKey: null,
        statusMessage: PAID_ANOTHER_WAY_MESSAGE,
      },
    });
  }

  // -------------------------------------------------------------------------
  // The sweep
  // -------------------------------------------------------------------------

  /** The pass, in every Hub process. Failures are logged by name only. */
  @Interval('plan-transfer-orders', TRANSFER_DEFAULTS.sweepMs)
  async tick(): Promise<void> {
    try {
      const r = await this.sweep();
      if (r.paid + r.pending + r.closed + r.expired + r.recovered > 0)
        this.logger.log(
          `transfer purchases: ${r.paid} paid, ${r.pending} confirming, ${r.closed} closed, ${r.expired} expired, ${r.recovered} recovered`,
        );
    } catch (e) {
      this.logger.error(
        `transfer purchases: a pass failed (${e instanceof Error ? e.name : 'Error'})`,
      );
    }
  }

  /**
   * One pass: lapse the orders whose window ended, recover the claims that
   * died, then settle the people who are due (a new credit, or a recheck that
   * came), the ones a credit may have paid for first, oldest order first,
   * until the time budget is spent. Nothing is held across a provider call.
   */
  async sweep(now: Date = new Date()): Promise<TransferSweepReport> {
    const report: TransferSweepReport = {
      expired: 0,
      recovered: 0,
      paid: 0,
      pending: 0,
      waiting: 0,
      closed: 0,
      retry: 0,
    };
    if (this.sweeping) return report;
    this.sweeping = true;
    try {
      report.expired = await this.expireLapsed(now);
      report.recovered = await this.recoverStale(now);
      const people = await this.duePeopleAt(now);
      const stop = Date.now() + TRANSFER_DEFAULTS.sweepBudgetMs;
      for (
        let i = 0;
        i < people.length && Date.now() < stop;
        i += TRANSFER_DEFAULTS.concurrency
      ) {
        const all = await Promise.all(
          people
            .slice(i, i + TRANSFER_DEFAULTS.concurrency)
            .map((person) => this.settlePerson(person, now)),
        );
        for (const outcomes of all)
          for (const o of outcomes) if (o !== 'skipped') report[o] += 1;
      }
      return report;
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Orders whose window lapsed: `expired`, nothing taken. Except an order whose
   * payment was made (the process died before it was linked): that one is
   * linked, never expired. Returns how many expired.
   */
  async expireLapsed(now: Date): Promise<number> {
    let expired = 0;
    for (;;) {
      const lapsedNow = await this.prisma.planTransferOrder.findMany({
        where: { status: ORDER_STATUS.awaiting, expiresAt: { lte: now } },
        orderBy: { createdAt: 'asc' },
        take: TRANSFER_DEFAULTS.batch,
      });
      let done = 0;
      for (const order of lapsedNow) {
        const made = await this.paymentOf(order);
        if (made) {
          // Paid and the window ran out before it was linked: it was paid.
          await this.link(order.id, made, [ORDER_STATUS.awaiting]);
          done += 1;
          continue;
        }
        const { count } = await this.prisma.planTransferOrder.updateMany({
          where: { id: order.id, status: ORDER_STATUS.awaiting },
          data: {
            status: ORDER_STATUS.expired,
            openKey: null,
            statusMessage: EXPIRED_MESSAGE,
          },
        });
        expired += count;
        done += 1;
      }
      if (done === 0 || lapsedNow.length < TRANSFER_DEFAULTS.batch) break;
    }
    return expired;
  }

  /**
   * An order `settling` for longer than a payment can take was held by a
   * process that died. Its idempotency key says what that process got to: a
   * payment (the order is linked to it), or nothing (the order waits again,
   * and the dead key is given back).
   */
  async recoverStale(now: Date): Promise<number> {
    const staleMs =
      this.provider.timings.moneyTimeoutMs + TRANSFER_DEFAULTS.staleGraceMs;
    const stale = await this.prisma.planTransferOrder.findMany({
      where: {
        status: ORDER_STATUS.settling,
        settlingSince: { lte: new Date(now.getTime() - staleMs) },
      },
      take: TRANSFER_DEFAULTS.batch,
    });
    let recovered = 0;
    for (const order of stale) {
      const made = await this.paymentOf(order);
      if (made) {
        recovered += (await this.link(order.id, made)) ? 1 : 0;
        continue;
      }
      // Nothing was made (or the payment failed and was let go of): the key is
      // given back and the order waits again.
      await this.prisma.moneyIdempotencyKey.deleteMany({
        where: { ...this.keyMatch(order), resourceId: null },
      });
      const back = await this.prisma.planTransferOrder.updateMany({
        where: { id: order.id, status: ORDER_STATUS.settling },
        data: {
          status: ORDER_STATUS.awaiting,
          settlingSince: null,
          nextCheckAt: now,
        },
      });
      recovered += back.count;
    }
    return recovered;
  }

  /** Which ledger rows are money in on a person's wallet (one or many people). */
  private creditsOf(
    who: string | { in: string[] },
  ): Prisma.FintavaLedgerEntryWhereInput {
    return {
      wawuUserId: who,
      walletKind: 'user',
      direction: 'in',
      status: 'completed',
      category: { in: [...MONEY_IN_CATEGORIES] },
      discrepancy: null,
      AND: [rowsOf(this.provider.name)],
    };
  }

  /** The newest credit on the person's wallet the Hub knows of, or null. */
  private async latestCreditAt(wawuUserId: string): Promise<Date | null> {
    const row = await this.prisma.fintavaLedgerEntry.findFirst({
      where: this.creditsOf(wawuUserId),
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    return row?.createdAt ?? null;
  }

  /**
   * The people with a waiting order that is due, in the order to settle them
   * (see `duePeople`). Reads every waiting order a light page at a time, then
   * asks the ledger for the newest money-in row of a page of people at once,
   * looking back no further than the oldest thing a waiting order has seen.
   * Database reads only; nothing is held when it returns.
   */
  private async duePeopleAt(now: Date): Promise<string[]> {
    const waiting: WaitingRow[] = [];
    let after: { createdAt: Date; id: string } | null = null;
    for (;;) {
      const page: WaitingRow[] = await this.prisma.planTransferOrder.findMany({
        where: {
          status: ORDER_STATUS.awaiting,
          expiresAt: { gt: now },
          ...(after
            ? {
                OR: [
                  { createdAt: { gt: after.createdAt } },
                  { createdAt: after.createdAt, id: { gt: after.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: TRANSFER_DEFAULTS.scanPage,
        select: {
          id: true,
          wawuUserId: true,
          createdAt: true,
          creditsSeenAt: true,
          nextCheckAt: true,
        },
      });
      waiting.push(...page);
      if (page.length < TRANSFER_DEFAULTS.scanPage) break;
      after = page[page.length - 1];
    }
    const seenSince = new Map<string, number>();
    for (const o of waiting) {
      const seen = (o.creditsSeenAt ?? o.createdAt).getTime();
      seenSince.set(
        o.wawuUserId,
        Math.min(seenSince.get(o.wawuUserId) ?? seen, seen),
      );
    }
    const latest = new Map<string, Date>();
    const everyone = [...seenSince.keys()];
    for (let i = 0; i < everyone.length; i += TRANSFER_DEFAULTS.lookupPage) {
      const chunk = everyone.slice(i, i + TRANSFER_DEFAULTS.lookupPage);
      const oldest = Math.min(...chunk.map((p) => seenSince.get(p) ?? 0));
      const rows = await this.prisma.fintavaLedgerEntry.groupBy({
        by: ['wawuUserId'],
        where: {
          ...this.creditsOf({ in: chunk }),
          createdAt: { gt: new Date(oldest) },
        },
        _max: { createdAt: true },
      });
      for (const r of rows)
        if (r.wawuUserId && r._max.createdAt)
          latest.set(r.wawuUserId, r._max.createdAt);
    }
    return duePeople(waiting, latest, now);
  }

  /**
   * One due person's waiting orders, oldest first, each settled with a balance
   * read of its own (so an older order is paid before a newer one, and only
   * while the balance covers it).
   */
  private async settlePerson(
    person: string,
    now: Date,
  ): Promise<SettleOutcome[]> {
    try {
      const orders = await this.prisma.planTransferOrder.findMany({
        where: {
          wawuUserId: person,
          status: ORDER_STATUS.awaiting,
          expiresAt: { gt: now },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true },
      });
      const out: SettleOutcome[] = [];
      for (const o of orders) out.push(await this.settleOrder(o.id, now));
      return out;
    } catch (e) {
      this.logger.error(
        `transfer purchases: a person's orders were not settled (${e instanceof Error ? e.name : 'Error'})`,
      );
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Settling one order
  // -------------------------------------------------------------------------

  /**
   * Takes the order (one conditional write: `awaiting` to `settling`), reads
   * the provider with nothing held, and either pays it from the wallet,
   * leaves it waiting, or closes it. Safe to call from two servers at once:
   * one gets the order, the other gets `skipped`.
   */
  async settleOrder(
    orderId: string,
    now: Date = new Date(),
  ): Promise<SettleOutcome> {
    const taken = await this.prisma.planTransferOrder.updateMany({
      where: {
        id: orderId,
        status: ORDER_STATUS.awaiting,
        expiresAt: { gt: now },
      },
      data: { status: ORDER_STATUS.settling, settlingSince: now },
    });
    if (taken.count !== 1) return 'skipped';
    const order = await this.prisma.planTransferOrder.findUniqueOrThrow({
      where: { id: orderId },
    });
    // The newest credit this attempt saw, once it has looked.
    const seen: { creditAt?: Date | null } = {};
    try {
      return await this.settleTaken(order, now, seen);
    } catch (e) {
      // Not a refusal we know: the order waits again, a little later. The
      // credit this attempt saw is marked, so only a newer credit wakes it
      // before then: the provider's limits are shared by every WAWU payment.
      this.logger.error(
        `transfer purchase ${order.id}: could not be settled (${e instanceof Error ? e.name : 'Error'}); it waits and is tried again`,
      );
      await this.waitAgain(order, now, {
        failed: true,
        creditsSeenAt: seen.creditAt,
      });
      return 'retry';
    }
  }

  private async settleTaken(
    order: PlanTransferOrder,
    now: Date,
    seen: { creditAt?: Date | null },
  ): Promise<SettleOutcome> {
    const kind = order.paymentKind as PurchasePaymentKind;
    if (!PURCHASE_PAYMENT_KINDS.includes(kind)) {
      await this.close(order, NOT_PAYABLE_ANY_MORE_MESSAGE);
      return 'closed';
    }
    // A payment an earlier, interrupted attempt made is this order's payment.
    const earlier = await this.paymentOf(order);
    if (earlier) {
      await this.link(order.id, earlier);
      return 'pending';
    }
    const wallet = await this.walletOf(order.wawuUserId);
    if (wallet === null) {
      await this.close(order, NO_WALLET_ANY_MORE_MESSAGE);
      return 'closed';
    }
    // Read before the balance: a credit that lands after this is seen again.
    const latest = await this.latestCreditAt(order.wawuUserId);
    seen.creditAt = latest;

    let quoted: Awaited<ReturnType<WalletPaymentService['currentQuote']>>;
    try {
      quoted = await this.payments.currentQuote(wallet, kind, order.targetId);
    } catch (e) {
      return this.afterRefusal(order, e, now, latest);
    }
    if (
      !sameQuote(order, {
        priceKobo: quoted.target.priceKobo,
        totalKobo: quoted.fee.totalKobo,
        terms: quoted.target.terms,
      })
    ) {
      await this.close(order, QUOTE_CHANGED_MESSAGE);
      return 'closed';
    }
    const other = await this.otherPayment(order);
    if (other === 'paid') {
      await this.close(order, PAID_ANOTHER_WAY_MESSAGE);
      return 'closed';
    }
    if (other === 'confirming') {
      await this.waitAgain(order, now, {
        delayMs: MINUTE_MS,
        creditsSeenAt: latest,
      });
      return 'retry';
    }
    if (quoted.availableKobo < order.totalKobo) {
      await this.waitAgain(order, now, { creditsSeenAt: latest });
      return 'waiting';
    }

    // The balance covers the total: pay it from the wallet, once.
    const scope: IdempotencyScope = {
      wawuUserId: order.wawuUserId,
      method: 'POST',
      route: PLAN_PURCHASE_ROUTE,
      key: settleKeyOf(order.id),
      fingerprint: bodyFingerprint({ transferOrder: order.id }),
    };
    try {
      scope.claimId = await this.keys.claim(scope, now);
    } catch (e) {
      // The key is held: an earlier attempt of this order is still on it.
      return this.afterRefusal(order, e, now, latest);
    }
    let payment: PaymentView;
    try {
      payment = await this.payments.pay(
        wallet,
        {
          kind,
          targetId: order.targetId,
          expectedTotalKobo: order.totalKobo,
          quoteToken: quoted.fee.quoteToken,
        },
        scope,
      );
    } catch (e) {
      // Nothing moved (a refusal before the debit, or one the provider
      // gave). A key that names a payment is kept: the next attempt links it.
      await this.keys.release(scope, true).catch(() => undefined);
      return this.afterRefusal(order, e, now, latest);
    }
    if (payment.status === 'failed')
      return this.afterFailedPayment(order, now, latest);
    await this.link(order.id, payment.id);
    return payment.status === 'completed' ? 'paid' : 'pending';
  }

  /**
   * The wallet payment came back `failed`: the provider refused it and nothing
   * moved. The order is not that payment's: the failed payment is let go of
   * (its key is freed, so the retry is a payment of its own, never a second
   * payment for one order) and the order waits again, tried later, unless its
   * window has lapsed, when it is expired with nothing taken.
   */
  private async afterFailedPayment(
    order: PlanTransferOrder,
    now: Date,
    latest: Date | null,
  ): Promise<SettleOutcome> {
    await this.letGo(order);
    if (lapsed(order, now)) {
      await this.prisma.planTransferOrder.updateMany({
        where: { id: order.id, status: ORDER_STATUS.settling },
        data: {
          status: ORDER_STATUS.expired,
          openKey: null,
          settlingSince: null,
          statusMessage: EXPIRED_MESSAGE,
        },
      });
      return 'closed';
    }
    // The credits seen so far are marked, so only a newer credit wakes it
    // before the rest it was given.
    await this.waitAgain(order, now, {
      failed: true,
      message: PAYMENT_FAILED_WAITING_MESSAGE,
      creditsSeenAt: latest,
    });
    return 'retry';
  }

  /** What a refusal while settling means for the order: closed, or waiting to be tried again. */
  private async afterRefusal(
    order: PlanTransferOrder,
    e: unknown,
    now: Date,
    latest: Date | null,
  ): Promise<SettleOutcome> {
    const code = e instanceof MoneyError ? e.code : null;
    if (code !== null && CLOSING_CODES.has(code)) {
      await this.close(
        order,
        e instanceof MoneyError
          ? messageOf(e) || NOT_PAYABLE_ANY_MORE_MESSAGE
          : NOT_PAYABLE_ANY_MORE_MESSAGE,
      );
      return 'closed';
    }
    if (code === 'insufficient_funds') {
      await this.waitAgain(order, now, { creditsSeenAt: latest });
      return 'waiting';
    }
    if (code === 'limit_reached' || code === 'daily_limit_exceeded') {
      await this.waitAgain(order, now, {
        failed: true,
        message: LIMIT_WAITING_MESSAGE,
        creditsSeenAt: latest,
      });
      return 'retry';
    }
    await this.waitAgain(order, now, { failed: true, creditsSeenAt: latest });
    return 'retry';
  }

  /** A wallet payment for the same item, made after the order, that is not this order's. */
  private async otherPayment(
    order: PlanTransferOrder,
  ): Promise<'none' | 'paid' | 'confirming'> {
    const rows = await this.prisma.walletPayment.findMany({
      where: {
        payerWawuUserId: order.wawuUserId,
        kind: { in: [...PURCHASE_PAYMENT_KINDS] },
        targetId: order.targetId,
        createdAt: { gte: order.createdAt },
        status: { in: ['pending', 'completed'] },
        NOT: order.paymentId ? { id: order.paymentId } : undefined,
      },
      select: { status: true },
    });
    if (rows.some((r) => r.status === 'completed')) return 'paid';
    return rows.length > 0 ? 'confirming' : 'none';
  }

  /** The person's open wallet, or null when they have none. */
  async walletOf(wawuUserId: string): Promise<OpenWallet | null> {
    try {
      return await this.gate.requireOpen(wawuUserId);
    } catch (e) {
      if (e instanceof MoneyError) return null;
      throw e;
    }
  }

  private keyMatch(order: Pick<PlanTransferOrder, 'id' | 'wawuUserId'>) {
    return {
      wawuUserId: order.wawuUserId,
      method: 'POST',
      route: PLAN_PURCHASE_ROUTE,
      key: settleKeyOf(order.id),
    };
  }

  // -------------------------------------------------------------------------
  // Recording the result (each one short write, nothing held)
  // -------------------------------------------------------------------------

  /**
   * The wallet payment exists: the order is that payment's. Once. `from` are
   * the states it may be linked from: `settling` (the settlement holds it), or
   * `awaiting` for a lapsed order whose payment was found before it expired.
   */
  private async link(
    orderId: string,
    paymentId: string,
    from: string[] = [ORDER_STATUS.settling],
  ): Promise<boolean> {
    const { count } = await this.prisma.planTransferOrder.updateMany({
      where: { id: orderId, status: { in: from } },
      data: {
        status: ORDER_STATUS.settled,
        paymentId,
        openKey: null,
        settlingSince: null,
        statusMessage: null,
      },
    });
    return count === 1;
  }

  /**
   * The payment an earlier attempt of this order made, found by the order's
   * own idempotency key: its id when it is pending or completed, null when
   * there is none. A key that names a payment that FAILED is let go of
   * (nothing moved, so the order may try again under a fresh key).
   */
  private async paymentOf(order: PlanTransferOrder): Promise<string | null> {
    const row = await this.prisma.moneyIdempotencyKey.findUnique({
      where: { wawuUserId_method_route_key: this.keyMatch(order) },
    });
    if (!row?.resourceId) return null;
    const payment = await this.prisma.walletPayment.findUnique({
      where: { id: row.resourceId },
      select: { status: true },
    });
    if (payment?.status === 'failed') {
      await this.letGo(order);
      return null;
    }
    return row.resourceId;
  }

  /** Frees the order's idempotency key after a payment that failed. */
  private async letGo(order: Pick<PlanTransferOrder, 'id' | 'wawuUserId'>) {
    await this.prisma.moneyIdempotencyKey.deleteMany({
      where: this.keyMatch(order),
    });
  }

  private async close(order: PlanTransferOrder, message: string) {
    await this.prisma.planTransferOrder.updateMany({
      where: { id: order.id, status: ORDER_STATUS.settling },
      data: {
        status: ORDER_STATUS.closed,
        openKey: null,
        settlingSince: null,
        statusMessage: message,
      },
    });
  }

  /** Back to waiting, with when it is looked at next. */
  private async waitAgain(
    order: PlanTransferOrder,
    now: Date,
    how: {
      creditsSeenAt?: Date | null;
      failed?: boolean;
      delayMs?: number;
      message?: string;
    } = {},
  ) {
    const checks = how.failed ? order.checks + 1 : 0;
    const delayMs =
      how.delayMs ??
      (how.failed ? backoffMs(checks) : TRANSFER_DEFAULTS.recheckMs);
    await this.prisma.planTransferOrder.updateMany({
      where: { id: order.id, status: ORDER_STATUS.settling },
      data: {
        status: ORDER_STATUS.awaiting,
        settlingSince: null,
        checks,
        nextCheckAt: new Date(now.getTime() + delayMs),
        statusMessage: how.message ?? null,
        ...(how.creditsSeenAt ? { creditsSeenAt: how.creditsSeenAt } : {}),
      },
    });
  }
}

/** Serialises writes of one person's orders (short; released with the transaction). */
async function lockPerson(tx: Tx, wawuUserId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`plan-transfer:${wawuUserId}`}, 0))`;
}

/** The sentence a money refusal carries. */
function messageOf(e: MoneyError): string {
  const body = e.getResponse();
  if (typeof body === 'object' && body !== null && 'message' in body) {
    const m = body.message;
    if (typeof m === 'string') return m;
  }
  return '';
}
