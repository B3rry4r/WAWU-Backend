import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '../../../generated/prisma/client';
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
import { isUniqueViolation } from '../prisma-unique';
import {
  EARNING_ADOPT_MAX_PAGES,
  EARNING_ADOPT_PAGE,
  EARNING_MOVE_MAX_EARNINGS,
  EARNING_NARRATION,
  EARNING_PLAN_PAGE,
  EARNING_SWEEP_BUDGET_MS,
  EARNING_SWEEP_PAGE,
  type EarningDay,
  type EarningMoveResult,
  type EarningSettlementResult,
  type EarningSettlementState,
  type EarningStatus,
  type EarningSweepCursor,
  type EarningWaiting,
  lagosDay,
  moveReference,
  NOT_SETTLED_HERE,
  waitingAfterRefusal,
  earningReference,
  HOST_SHARE_KIND,
  HOST_SHARE_TITLE,
  hostShareReference,
} from './earning-rules';

import type { UnsweptSalesPage } from './earning-review.type';

type SettlementRow = Prisma.EarningSettlementGetPayload<object>;
type MoveRow = Prisma.EarningMoveGetPayload<object>;

const MINUTE = 60_000;
const HOUR = 3_600_000;

/** The rest before the next try or question: 1, 2, 4 ... minutes, at most an hour. */
function restMs(count: number): number {
  return Math.min(60, 2 ** Math.min(Math.max(count, 0), 6)) * MINUTE;
}

/** Thrown inside the move's transaction when another caller took its earnings first: the whole write is undone. */
class MoveTakenElsewhere extends Error {}

/** True when the creator has a wallet of this provider (a row of `FintavaWallet`, however the provider is named). */
function hasWalletOf(payee: Prisma.Sql, provider: string): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM "FintavaWallet" w
     WHERE w."wawuUserId" = ${payee}
       AND LOWER(BTRIM(COALESCE(w."provider", 'fintava'))) = ${provider})`;
}

/** The answer to a cursor the before-start list did not give. */
const UNSWEPT_CURSOR_MESSAGE = 'cursor is not one this list gave.';

/**
 * A sale's 85% lands in the payee's wallet (task WALLET-16, R-11, R-55).
 *
 * An ordinary sale (an unlock, a tip, a legal fee, school fees: any kind that
 * is not held) is paid into WAWU's own account at the wallet provider
 * (MONEY-17). Nothing asks for the payee's share: when the sale is finished
 * (completed, delivered, not in review) the sweep makes one `EarningSettlement`
 * for it, the record of what the sale earned (the payee's 85%, R-5). The 15%
 * is WAWU's and stays. A held kind (a paid DM, a ticket, a bill) never comes
 * here: its share lands when the owning feature releases the hold (MONEY-18),
 * and the database refuses a settlement for it.
 *
 * **One move a day per creator** (R-55, owner, 16 Oct 2026; G-703). The
 * earnings do not travel one by one. Once a day a creator's earnings that no
 * move has taken yet go to their wallet in ONE transfer (`EarningMove`), if
 * their total is at least the floor (N200, `EARNINGS_MOVE_MIN_KOBO`); a total
 * under it waits and is added to the next day's. A day is the Africa/Lagos
 * calendar day. The provider's charge on a transfer is WAWU's, paid from its
 * 15% (R-31): the payee receives the whole total, and WAWU pays the charge
 * once per creator per day, not once per sale. A creator has one open move at
 * a time and at most one transfer a day (one made today, or one that landed
 * today, counts for the day); (creator, day) is unique in the table, so two
 * servers make one. The reference names the creator and the day
 * (`moveReference`), so the provider sees the move once. The earnings in a
 * move are fixed when it is made; those that arrive later wait for the next.
 *
 * **Once.** One move, one reference at the provider, so asking again, from
 * the sweep, a second Hub process or after a restart, never moves it twice.
 * The move is handed over by a lease (`sentAt`) only one caller wins.
 *
 * **The provider's record is the truth.** The move is `landed` (and every
 * earning in it with it, in one write) only when the provider confirmed it,
 * from its answer to the send, or from its record of our reference when the
 * answer was lost. A move whose outcome is unknown (a timeout, a 5xx, a
 * transfer accepted and not finished, a repeated reference, a Hub killed
 * between the provider's answer and our write) is asked about, backing off to
 * hourly, and is never sent again and never read as "nothing moved"; past
 * PAYMENT_REVIEW_AFTER_HOURS it goes to a person. Only the provider's own
 * record that the move failed starts a new try, under a new reference. A
 * balance is never added up from earnings: the provider's is the only one.
 *
 * **A refusal gets a person after 72 hours** (R-55): a move the wallet refuses
 * (nothing moved) is tried again, and 72 hours after its FIRST refusal
 * (`firstRefusedAt`, EARNINGS_REFUSED_REVIEW_AFTER_HOURS) it goes to a person.
 * Later refusals do not restart the count, and the review is set once.
 *
 * **Waiting is not failing.** A person with no wallet yet (R-11: they keep
 * earning and are moved the day the wallet exists), a frozen wallet (BACKEND_
 * GAPS G-10), WAWU's own account short of money, the provider out of reach or
 * without the move yet (`not_supported`): the earnings stay owed, the money
 * stays in WAWU's account, and the sweep tries again.
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
   * What is owed now: the earnings still `owed` of the provider this server
   * runs, counted and summed in kobo. The money is in WAWU's own account until
   * the provider confirms the move, so it is part of what that account holds.
   * Never shown as a balance. The nightly check (MONEY-16) does not call this:
   * an earning sent and not yet confirmed has no ledger row, and the check
   * leaves any movement younger than its settle window (30 minutes,
   * `DEFAULT_SETTLE_MINUTES`) to the next run; one still unconfirmed after
   * that is a finding it is right to raise.
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

  /** The earning of a payment, with where its move stands, or null when it has none. */
  async forPayment(paymentId: string): Promise<EarningSettlementResult | null> {
    const row = await this.prisma.earningSettlement.findUnique({
      where: { paymentId },
    });
    return row ? this.settlementResult(row) : null;
  }

  // -------------------------------------------------------------------------
  // The sweep
  // -------------------------------------------------------------------------

  /**
   * Every minute: first every finished ordinary sale that has no earning yet
   * becomes one (`adopt`); then the creators whose earnings are ready for
   * their move of the day get it (`plan`); then every move that is owed, not
   * under review and due, of the provider this server runs, is driven a step.
   *
   * The pass walks EVERY due move by a keyset cursor (creation time, then id),
   * with no cap on the rows it looks at, the way the hold sweep does (MONEY-18
   * round 2, F4). It stops only at the end of the due moves or when its time
   * is used (`budgetMs`), and the next pass starts where this one stopped. A
   * creator with no wallet has no move: their earnings are marked as waiting
   * for a wallet and the planner picks them up in the first pass after the
   * wallet exists (R-11).
   *
   * The counts are for logs and tests: `adopted` earnings made, `planned`
   * moves made, `checked` moves looked at, `landed` moves that were landed
   * when this pass looked at them (another process may have landed one in the
   * same minute, and both count it; the move is landed once either way).
   */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'money-earning-settle' })
  async sweep(
    now = new Date(),
    opts: { budgetMs?: number } = {},
  ): Promise<{
    adopted: number;
    planned: number;
    checked: number;
    landed: number;
  }> {
    const counts = { adopted: 0, planned: 0, checked: 0, landed: 0 };
    if (this.sweeping) return counts;
    this.sweeping = true;
    const budgetMs = opts.budgetMs ?? EARNING_SWEEP_BUDGET_MS;
    const started = Date.now();
    try {
      counts.adopted = await this.adopt();
      counts.adopted += await this.adoptHostShares();
      counts.planned = await this.plan(now, started, budgetMs);
      let after: EarningSweepCursor | null = this.sweepAfter;
      for (;;) {
        const where: Prisma.EarningMoveWhereInput = {
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
        const due = await this.prisma.earningMove.findMany({
          where,
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: EARNING_SWEEP_PAGE,
          select: { id: true, createdAt: true },
        });
        for (const { id, createdAt } of due) {
          counts.checked += 1;
          try {
            const s = await this.driveMove(id, now);
            if (s.state === 'landed') counts.landed += 1;
          } catch (e) {
            this.logger.error(
              `earning move ${id}: the sweep could not drive it (${e instanceof Error ? e.name : 'error'})`,
            );
          }
          // Out of time (a slow provider spends it a move at a time): the
          // next pass starts after this one.
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

  // -------------------------------------------------------------------------
  // The day's move (R-55)
  // -------------------------------------------------------------------------

  /**
   * Makes the day's move for every creator who is ready for it: they have
   * earnings no move has taken, a wallet of this provider, a total of at
   * least the floor, no open move, and no move made or landed today. Returns
   * how many moves it made. Idempotent and safe between servers: see
   * `makeMove`.
   */
  private async plan(
    now: Date,
    started: number,
    budgetMs: number,
  ): Promise<number> {
    const day = lagosDay(now);
    const provider = this.provider.name;
    const floor = this.settings.earningsMoveMinKobo.toString();
    await this.markWalletWaiting(provider);
    let made = 0;
    let after = '';
    for (;;) {
      const page = await this.prisma.$queryRaw<Array<{ payee: string }>>(
        Prisma.sql`
          SELECT s."payeeWawuUserId" AS "payee"
            FROM "EarningSettlement" s
           WHERE s."status" = 'owed' AND s."moveId" IS NULL
             AND s."reviewSince" IS NULL AND s."provider" = ${provider}
             AND s."payeeWawuUserId" > ${after}
             AND ${hasWalletOf(Prisma.sql`s."payeeWawuUserId"`, provider)}
             AND NOT EXISTS (
               SELECT 1 FROM "EarningMove" m
                WHERE m."payeeWawuUserId" = s."payeeWawuUserId"
                  AND m."provider" = ${provider}
                  AND (m."dayKey" = ${day.key}
                       OR (m."status" = 'owed' AND m."reviewSince" IS NULL)
                       OR (m."settledAt" >= ${day.start} AND m."settledAt" < ${day.end})))
           GROUP BY s."payeeWawuUserId"
          HAVING SUM(s."amountKobo") >= ${floor}::bigint
           ORDER BY s."payeeWawuUserId"
           LIMIT ${EARNING_PLAN_PAGE}`,
      );
      for (const { payee } of page) {
        try {
          if (await this.makeMove(payee, now, day)) made += 1;
        } catch (e) {
          this.logger.error(
            `earnings of ${payee}: the day's move could not be made (${e instanceof Error ? e.name : 'error'})`,
          );
        }
        if (Date.now() - started >= budgetMs) return made;
      }
      if (page.length < EARNING_PLAN_PAGE) break;
      after = page[page.length - 1].payee;
    }
    return made;
  }

  /**
   * Marks the earnings of a creator with no wallet as waiting for one (R-11:
   * they keep earning), and clears the mark once the wallet exists. Two
   * statements; they change nothing else and move no money.
   */
  private async markWalletWaiting(provider: string): Promise<void> {
    try {
      const payee = Prisma.sql`s."payeeWawuUserId"`;
      await this.prisma.$executeRaw(Prisma.sql`
        UPDATE "EarningSettlement" s SET "waiting" = 'payee_wallet'
         WHERE s."status" = 'owed' AND s."moveId" IS NULL
           AND s."reviewSince" IS NULL AND s."provider" = ${provider}
           AND s."waiting" IS DISTINCT FROM 'payee_wallet'
           AND NOT ${hasWalletOf(payee, provider)}`);
      await this.prisma.$executeRaw(Prisma.sql`
        UPDATE "EarningSettlement" s SET "waiting" = NULL
         WHERE s."status" = 'owed' AND s."moveId" IS NULL
           AND s."reviewSince" IS NULL AND s."provider" = ${provider}
           AND s."waiting" = 'payee_wallet'
           AND ${hasWalletOf(payee, provider)}`);
    } catch (e) {
      // The marks are for people reading the table; the planner does not use them.
      this.logger.error(
        `earning sweep: could not mark the earnings waiting for a wallet (${e instanceof Error ? e.name : 'error'})`,
      );
    }
  }

  /**
   * The creator's move for the day, or null when there is nothing to move.
   * One short transaction, nothing held across a call to the provider:
   *
   * 1. the creator's earnings that no move has taken, oldest first;
   * 2. their sales are read FOR SHARE (the order the lease takes them in: the
   *    sale, then the earning) and the earnings FOR UPDATE, so a second server
   *    asking at the same moment waits here and then finds them taken;
   * 3. nothing is made when the creator has an open move, or one made or
   *    landed today (one transfer a day);
   * 4. an earning whose sale is no longer a finished one goes to a person
   *    instead; one over the provider's cap on a single move goes to a person
   *    too (never split, WALLET.md lead ruling 1); the rest are taken oldest
   *    first from one account of WAWU's, as many as the cap allows (the
   *    others wait for the next day);
   * 5. under the floor, nothing is made and the earnings wait for the next day;
   * 6. the move is written with the sum, and the earnings point at it.
   */
  private async makeMove(
    payee: string,
    now: Date,
    day: EarningDay,
  ): Promise<string | null> {
    const provider = this.provider.name;
    const floor = BigInt(this.settings.earningsMoveMinKobo);
    const capSetting = this.fees.providerFees.merchantMaxPerTxnKobo;
    const cap = capSetting === null ? null : BigInt(capSetting);
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const candidates = await tx.earningSettlement.findMany({
            where: {
              payeeWawuUserId: payee,
              provider,
              status: 'owed',
              moveId: null,
              reviewSince: null,
            },
            orderBy: [{ earnedAt: 'asc' }, { id: 'asc' }],
            take: EARNING_MOVE_MAX_EARNINGS,
            select: {
              id: true,
              paymentId: true,
              amountKobo: true,
              merchantAccountNumber: true,
            },
          });
          if (candidates.length === 0) return null;
          // A host's share of spent credits has no sale to be finished
          // (WALLET-17): it is owed from the moment it is made.
          const saleIds = candidates.flatMap((c) =>
            c.paymentId ? [c.paymentId] : [],
          );
          const finished = saleIds.length
            ? await tx.$queryRaw<Array<{ id: string }>>(
                Prisma.sql`
              SELECT "id" FROM "WalletPayment"
               WHERE "id" IN (${Prisma.join(saleIds)})
                 AND "status" = 'completed'
                 AND "reviewSince" IS NULL AND "chargeReviewSince" IS NULL
               ORDER BY "id" FOR SHARE`,
              )
            : [];
          const finishedSales = new Set(finished.map((r) => r.id));
          const locked = await tx.$queryRaw<Array<{ id: string }>>(
            Prisma.sql`
              SELECT "id" FROM "EarningSettlement"
               WHERE "id" IN (${Prisma.join(candidates.map((c) => c.id))})
                 AND "status" = 'owed' AND "moveId" IS NULL
                 AND "reviewSince" IS NULL
               ORDER BY "id" FOR UPDATE`,
          );
          const open = new Set(locked.map((r) => r.id));
          if (open.size === 0) return null;
          const already = await tx.earningMove.findFirst({
            where: {
              payeeWawuUserId: payee,
              provider,
              OR: [
                { dayKey: day.key },
                { status: 'owed', reviewSince: null },
                { settledAt: { gte: day.start, lt: day.end } },
              ],
            },
            select: { id: true },
          });
          if (already) return null;

          let account: string | null = null;
          let sum = 0n;
          const members: string[] = [];
          for (const c of candidates) {
            if (!open.has(c.id)) continue;
            if (c.paymentId !== null && !finishedSales.has(c.paymentId)) {
              await this.reviewEarning(
                tx,
                c.id,
                now,
                'the sale is no longer a finished one (not completed, or under review); the earning waits for a person',
              );
              continue;
            }
            if (cap !== null && c.amountKobo > cap) {
              await this.reviewEarning(
                tx,
                c.id,
                now,
                `the earning of ${c.amountKobo} kobo is above the cap of ${cap} kobo on one move through WAWU's account`,
              );
              continue;
            }
            account ??= c.merchantAccountNumber;
            if (c.merchantAccountNumber !== account) continue;
            if (cap !== null && sum + c.amountKobo > cap) continue;
            members.push(c.id);
            sum += c.amountKobo;
          }
          if (members.length === 0 || sum < floor) return null;

          const move = await tx.earningMove.create({
            data: {
              payeeWawuUserId: payee,
              dayKey: day.key,
              provider,
              merchantAccountNumber: account!,
              amountKobo: sum,
              earnings: members.length,
              customerReference: moveReference(payee, day.key, 1),
            },
          });
          const { count } = await tx.earningSettlement.updateMany({
            where: {
              id: { in: members },
              moveId: null,
              status: 'owed',
              reviewSince: null,
            },
            data: { moveId: move.id },
          });
          if (count !== members.length) throw new MoveTakenElsewhere();
          return move.id;
        },
        { maxWait: 10_000, timeout: 30_000 },
      );
    } catch (e) {
      // Another server made today's move first, or took these earnings: theirs stands.
      if (isUniqueViolation(e) || e instanceof MoveTakenElsewhere) return null;
      throw e;
    }
  }

  /** An earning out of the sweep for a person, inside the transaction that found it. */
  private async reviewEarning(
    tx: Prisma.TransactionClient,
    id: string,
    now: Date,
    note: string,
  ): Promise<void> {
    await tx.earningSettlement.updateMany({
      where: { id, status: 'owed', moveId: null, reviewSince: null },
      data: { reviewSince: now, discrepancy: note },
    });
    this.logger.error(`earning ${id}: ${note}; sent to review`);
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
    const start = await this.sweepStart();
    // Sales the database refused in this pass: left out of the next pages, so
    // one sale cannot keep the others from being taken.
    const refused: string[] = [];
    for (let page = 0; page < EARNING_ADOPT_MAX_PAGES; page += 1) {
      const sales = await this.prisma.walletPayment.findMany({
        where: {
          ...this.saleFilter(),
          id: { notIn: refused },
          // Only sales made on or after the start (lead ruling 17 Oct):
          // an older unsettled sale is never paid by the sweep.
          completedAt: { gte: start.at },
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
   * A community host's share of the credits spent in their room becomes an
   * earning (WALLET-17), and so travels in the host's one move a day with
   * their sales (R-55). Once per spent credit (`creditSpendEarningId` is
   * unique), for exactly `hostShareKobo` (85% of what WAWU collected for the
   * credits, R-5), owed to the room's host, in WAWU's account.
   *
   * Only a spend that was paid for from the wallet is taken: every credit it
   * used came from a pack bought with the wallet, whose price is in WAWU's
   * account at the provider this server runs (one account, one provider).
   * Credits from the web's Flutterwave packs are WAWU's money at Flutterwave,
   * not here, and a spend that mixed the two has no honest split recorded:
   * both wait for the web to follow (BACKEND_GAPS). A spend before the sweep's
   * start (lead ruling 17 Oct) is never taken.
   */
  private async adoptHostShares(): Promise<number> {
    const start = await this.sweepStart();
    const provider = this.provider.name;
    let made = 0;
    const refused: string[] = [];
    for (let page = 0; page < EARNING_ADOPT_MAX_PAGES; page += 1) {
      const found = await this.prisma.$queryRaw<
        Array<{
          id: string;
          creator: string;
          community: string;
          kobo: string;
          at: Date;
          account: string;
        }>
      >(Prisma.sql`
        SELECT e."id", e."creatorWawuId" AS "creator", e."communityId" AS "community",
               e."hostShareKobo"::text AS "kobo", e."earnedAt" AS "at",
               MIN(p."merchantAccountNumber") AS "account"
          FROM "CreditSpendEarning" e
          CROSS JOIN LATERAL unnest(e."lotIds") AS lot(id)
          JOIN "CreditLot" l ON l."id" = lot.id
          JOIN "CreditPurchase" cp ON cp."id" = l."creditPurchaseId"
          LEFT JOIN "WalletPayment" p
                 ON p."id" = cp."walletPaymentId" AND p."status" = 'completed'
         WHERE e."hostShareKobo" > 0 AND e."earnedAt" >= ${start.at}
           AND NOT EXISTS (SELECT 1 FROM "EarningSettlement" s
                            WHERE s."creditSpendEarningId" = e."id")
           AND e."id" <> ALL(${refused}::text[])
         GROUP BY e."id"
        HAVING COUNT(*) = COUNT(p."id")
           AND COUNT(DISTINCT p."merchantAccountNumber") = 1
           AND COUNT(DISTINCT p."provider") = 1
           AND MIN(p."provider") = ${provider}
         ORDER BY e."earnedAt" ASC, e."id" ASC
         LIMIT ${EARNING_ADOPT_PAGE}`);
      if (found.length === 0) break;
      const rows = found.map((f) => ({
        creditSpendEarningId: f.id,
        payeeWawuUserId: f.creator,
        kind: HOST_SHARE_KIND,
        targetId: f.community,
        title: HOST_SHARE_TITLE,
        earnedAt: f.at,
        amountKobo: BigInt(f.kobo),
        merchantAccountNumber: f.account,
        provider,
        customerReference: hostShareReference(f.id, 1),
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
            refused.push(row.creditSpendEarningId);
            this.logger.error(
              `credit earning ${row.creditSpendEarningId}: its earning could not be made (${e instanceof Error ? e.name : 'error'}); a person looks`,
            );
          }
        }
      }
      if (found.length < EARNING_ADOPT_PAGE) break;
    }
    return made;
  }

  /**
   * The sales the sweep may turn into earnings, apart from when they were
   * made: finished (completed, delivered, no review mark), of the running
   * provider, with a payee and a share, not held, and with no earning yet.
   */
  private saleFilter(): Prisma.WalletPaymentWhereInput {
    return {
      status: 'completed',
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
    };
  }

  /**
   * The time from which the sweep pays sales (lead ruling 17 Oct 2026, the
   * owner may override): the setting EARNINGS_SWEEP_START when it is set,
   * else the moment this code first reached the environment, stored once in
   * `EarningSweepStart` (the migration writes the row; a missing row is
   * written here, by whoever gets there first, and never changed after).
   * A sale completed before it is never paid by the sweep; it is listed for
   * an admin (`unsweptBeforeStart`).
   */
  async sweepStart(): Promise<{ at: Date; source: 'config' | 'first_run' }> {
    const configured = this.settings.earningsSweepStart;
    if (configured) return { at: configured, source: 'config' };
    let row = await this.prisma.earningSweepStart.findUnique({
      where: { id: 1 },
    });
    if (!row) {
      await this.prisma.earningSweepStart.createMany({
        data: [{ id: 1, startedAt: new Date() }],
        skipDuplicates: true,
      });
      row = await this.prisma.earningSweepStart.findUniqueOrThrow({
        where: { id: 1 },
      });
    }
    return { at: row.startedAt, source: 'first_run' };
  }

  /**
   * Finished sales with a payee that were made before the sweep's start and
   * have no earning: the ones the sweep will never pay, for an admin to look
   * at (oldest first, a cursor page: `nextCursor` is the last payment id seen).
   */
  async unsweptBeforeStart(
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<UnsweptSalesPage> {
    const start = await this.sweepStart();
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
    const where: Prisma.WalletPaymentWhereInput = {
      ...this.saleFilter(),
      completedAt: { lt: start.at },
    };
    const total = await this.prisma.walletPayment.count({ where });
    let cursor: Prisma.WalletPaymentWhereInput = {};
    if (opts.cursor) {
      const seen = await this.prisma.walletPayment.findUnique({
        where: { id: opts.cursor },
        select: { completedAt: true },
      });
      // A cursor this list did not give (a payment that is not here) is a
      // plain 400, not a restart at page 1 (CONVENTIONS section 6).
      if (!seen?.completedAt) {
        throw new BadRequestException(UNSWEPT_CURSOR_MESSAGE);
      }
      cursor = {
        OR: [
          { completedAt: { gt: seen.completedAt } },
          { completedAt: seen.completedAt, id: { gt: opts.cursor } },
        ],
      };
    }
    const rows = await this.prisma.walletPayment.findMany({
      where: { AND: [where, cursor] },
      orderBy: [{ completedAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      select: {
        id: true,
        kind: true,
        targetId: true,
        title: true,
        payeeWawuUserId: true,
        payeeShareKobo: true,
        completedAt: true,
      },
    });
    const page = rows.slice(0, limit);
    return {
      startsAt: start.at.toISOString(),
      source: start.source,
      count: total,
      items: page.map((r) => ({
        paymentId: r.id,
        kind: r.kind,
        targetId: r.targetId,
        title: r.title,
        payeeWawuUserId: r.payeeWawuUserId!,
        payeeShareKobo: koboNumber(r.payeeShareKobo),
        completedAt: r.completedAt!.toISOString(),
      })),
      nextCursor: rows.length > limit ? page[page.length - 1].id : null,
    };
  }

  /**
   * Moves an earning's move one step (the earning a caller holds is only a
   * way to name the move it travels in): see `driveMove`. An earning that has
   * no move yet is not driven: the planner gives it one.
   */
  async drive(
    settlementId: string,
    now = new Date(),
  ): Promise<EarningSettlementResult> {
    const s = await this.load(settlementId);
    if (s.moveId) await this.driveMove(s.moveId, now);
    return this.settlementResult(await this.load(settlementId));
  }

  /**
   * Moves a creator's move one step: asks the provider about a move that was
   * handed over, or hands it over. Never sends a move whose outcome is
   * unknown.
   */
  async driveMove(
    moveId: string,
    now = new Date(),
  ): Promise<EarningMoveResult> {
    const m = await this.loadMove(moveId);
    if (m.status !== 'owed') return this.moveResult(m);
    if (m.reviewSince) return this.moveResult(m);
    // Not yet due: a lease on a call in flight, or a back-off.
    if (m.nextAttemptAt && m.nextAttemptAt.getTime() > now.getTime()) {
      return this.moveResult(m);
    }
    if (!isRowOf(this.provider.name, m.provider)) {
      // Another provider took these sales (written before a switch of
      // WALLET_PROVIDER): this one's silence says nothing and it sends
      // nothing. It waits for its own provider.
      return this.waitFor(m, 'provider', now, true);
    }
    return m.sentAt ? this.reconcile(m, now) : this.send(m, now);
  }

  private load(id: string): Promise<SettlementRow> {
    return this.prisma.earningSettlement.findUniqueOrThrow({ where: { id } });
  }

  private loadMove(id: string): Promise<MoveRow> {
    return this.prisma.earningMove.findUniqueOrThrow({ where: { id } });
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  private async send(m: MoveRow, now: Date): Promise<EarningMoveResult> {
    // R-55: 72 hours after the wallet FIRST refused this move, a person looks,
    // whatever it is doing now. Nothing is in flight here (`sentAt` is null).
    if (this.refusedTooLong(m, now)) {
      return this.toReview(
        m,
        `the wallet first refused this move ${this.settings.earningsRefusedReviewAfterHours} hours ago and it has not landed`,
      );
    }
    const amount = m.amountKobo;
    const cap = this.fees.providerFees.merchantMaxPerTxnKobo;
    if (cap !== null && amount > BigInt(cap)) {
      // Refuse, never split (WALLET.md, lead ruling 1): a person decides.
      return this.toReview(
        m,
        `the move of ${amount} kobo is above the cap of ${cap} kobo on one move through WAWU's account`,
      );
    }

    const wallet = await this.prisma.fintavaWallet.findUnique({
      where: { wawuUserId: m.payeeWawuUserId },
      select: { accountNumber: true, provider: true },
    });
    if (!wallet || !isRowOf(this.provider.name, wallet.provider)) {
      // R-11: a creator without a wallet keeps earning; the money waits.
      return this.waitFor(m, 'payee_wallet', now);
    }
    if (
      await this.isWawuAccount(m.merchantAccountNumber, wallet.accountNumber)
    ) {
      return this.toReview(
        m,
        "the move would take money from WAWU's account to WAWU's account",
      );
    }

    // The lease: only the caller that wins it hands the move to the provider.
    // `sentAt` set means a record may exist at the provider from here on. Every
    // sale in the move must still be a finished one at this moment: the sales
    // are read FOR SHARE, so a review mark set since the move was made either
    // is seen here or waits for the lease to commit. An earning whose
    // sale is not finished any more leaves the move for a person (and the move
    // is made again, smaller, under a new reference, on the next look: nothing
    // was sent). A conditional update on the move's own row is what makes one
    // caller win between servers.
    const leaseUntil = new Date(
      now.getTime() +
        this.provider.timings.moneyTimeoutMs +
        this.provider.timings.resendSafetyMs,
    );
    const leased = await this.prisma.$transaction(async (tx) => {
      // The move's row first: a second caller waits here, and then finds the
      // move leased, shrunk or withdrawn.
      const mine = await tx.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`
          SELECT "id" FROM "EarningMove"
           WHERE "id" = ${m.id} AND "status" = 'owed'
             AND "sentAt" IS NULL AND "reviewSince" IS NULL
           FOR UPDATE`,
      );
      if (mine.length === 0) return { kind: 'lost' as const };
      const members = await tx.earningSettlement.findMany({
        where: { moveId: m.id },
        select: { id: true, paymentId: true, amountKobo: true },
        orderBy: { id: 'asc' },
      });
      const saleIds = members.flatMap((x) =>
        x.paymentId ? [x.paymentId] : [],
      );
      const finished = saleIds.length
        ? await tx.$queryRaw<Array<{ id: string }>>(
            Prisma.sql`
              SELECT "id" FROM "WalletPayment"
               WHERE "id" IN (${Prisma.join(saleIds)})
                 AND "status" = 'completed'
                 AND "reviewSince" IS NULL AND "chargeReviewSince" IS NULL
               ORDER BY "id" FOR SHARE`,
          )
        : [];
      const ok = new Set(finished.map((r) => r.id));
      const gone = members.filter(
        (x) => x.paymentId !== null && !ok.has(x.paymentId),
      );
      if (gone.length > 0) {
        // Nothing may be sent for these: out of the move, for a person. The
        // move shrinks (a new reference, the old one may have been tried) or,
        // with nothing left, is withdrawn.
        const note =
          'the sale is no longer a finished one (not completed, or under review); the earning waits for a person';
        await tx.earningSettlement.updateMany({
          where: { id: { in: gone.map((x) => x.id) }, moveId: m.id },
          data: { moveId: null, reviewSince: now, discrepancy: note },
        });
        const left = members.filter(
          (x) => x.paymentId === null || ok.has(x.paymentId),
        );
        if (left.length === 0) {
          await tx.earningMove.deleteMany({
            where: { id: m.id, status: 'owed', sentAt: null },
          });
        } else {
          await tx.earningMove.updateMany({
            where: { id: m.id, status: 'owed', sentAt: null },
            data: {
              amountKobo: left.reduce((sum, x) => sum + x.amountKobo, 0n),
              earnings: left.length,
              attempt: m.attempt + 1,
              customerReference: moveReference(
                m.payeeWawuUserId,
                m.dayKey,
                m.attempt + 1,
              ),
            },
          });
        }
        return { kind: 'changed' as const, note, count: gone.length };
      }
      const { count } = await tx.earningMove.updateMany({
        where: {
          id: m.id,
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
      return { kind: count === 1 ? ('leased' as const) : ('lost' as const) };
    });
    if (leased.kind === 'changed') {
      this.logger.error(
        `earning move ${m.id}: ${leased.count} earning(s) left it because their sale is no longer a finished one; sent to review`,
      );
      return this.moveResultOrGone(m.id);
    }
    if (leased.kind === 'lost')
      return this.moveResult(await this.loadMove(m.id));

    let receipt: ProviderTransferReceipt;
    try {
      receipt = await this.provider.walletToWallet({
        fromAccountNumber: m.merchantAccountNumber,
        toAccountNumber: wallet.accountNumber,
        amountKobo: amount,
        reference: m.customerReference,
        narration: EARNING_NARRATION,
      });
    } catch (e) {
      return this.afterRefusal(m, e, now);
    }
    return this.afterReceipt(
      { ...m, destinationAccountNumber: wallet.accountNumber },
      receipt,
      now,
    );
  }

  /** The move, or what is left to say when it was withdrawn because nothing was left in it. */
  private async moveResultOrGone(id: string): Promise<EarningMoveResult> {
    const m = await this.prisma.earningMove.findUnique({ where: { id } });
    if (m) return this.moveResult(m);
    return {
      moveId: id,
      payeeWawuUserId: '',
      state: 'waiting',
      waiting: null,
      status: 'owed',
      amountKobo: 0n,
      earnings: 0,
    };
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
    m: MoveRow,
    e: unknown,
    now: Date,
  ): Promise<EarningMoveResult> {
    const refusal = e instanceof WalletProviderError ? e : null;
    if (refusal?.providerFailed) {
      // The provider TOOK the move and its own record says it failed (FIX-66):
      // the money is where it was, but the reference is spent, because the
      // provider answers a repeat of it with that same failed record. The
      // provider is asked once more (a read, nothing is sent), and its record
      // starts the new try under a new reference, the same step a failure
      // found by the sweep takes (R-55 counts the 72 hours from the first).
      this.logger.warn(
        `earning move ${m.id}: ${this.provider.label} took the move and says it failed; reading its record`,
      );
      return this.reconcile(m, now);
    }
    if (!refusal || (refusal.recordMayExist && !refusal.requestNotSent)) {
      // Money may have moved (a lost answer, a transfer accepted and not
      // finished, a repeated reference): asked about, never sent again. A
      // request that PROVABLY never reached the provider (a refused
      // connection, a host name that did not resolve: `requestNotSent`) is
      // not here: nothing was sent, so it is the refusal below.
      this.logger.warn(
        `earning move ${m.id}: the outcome is unknown (${refusal?.kind ?? 'error'}); asking ${this.provider.label} about it`,
      );
      await this.schedule(m, now, 1);
      return this.moveResult(await this.loadMove(m.id));
    }
    // A refusal that moved nothing: the lease is given back, the same
    // reference is used again (a refused send does not use it up).
    const { waiting, loud } = waitingAfterRefusal(refusal);
    if (refusal.requestNotSent) {
      this.logger.warn(
        `earning move ${m.id}: ${this.provider.label} could not be reached (the request was not sent); it is tried again under the same reference`,
      );
    } else if (waiting === 'funds') {
      this.logger.error(
        `earning move ${m.id}: ${this.provider.label} says WAWU's own account cannot cover the move (${m.amountKobo} kobo): the sales' money is not where it should be`,
      );
    } else if (waiting === 'not_supported') {
      this.logger.error(
        `earning move ${m.id}: ${this.provider.label} cannot make this move yet (not supported); the move of ${m.amountKobo} kobo waits and lands when it can`,
      );
    } else if (loud) {
      this.logger.error(
        `earning move ${m.id}: ${this.provider.label} refused the move (${refusal.kind}); nothing moved`,
      );
    }
    // R-55: the FIRST refusal starts the 72 hours. It is written once (the
    // condition decides between servers) and never moved by a later refusal.
    if (waiting === 'refused') await this.markFirstRefusal(m.id, now);
    const first = (await this.loadMove(m.id)).firstRefusedAt;
    await this.prisma.earningMove.updateMany({
      where: { id: m.id, status: 'owed', sentAt: { not: null } },
      data: {
        sentAt: null,
        waiting,
        nextAttemptAt: this.nextLookAfterRefusal(
          now,
          restMs(m.attempts + 1),
          first,
        ),
      },
    });
    // The move may have been refused for 72 hours already (an old first
    // refusal, then a different reason to wait, then refused again): the
    // lease is given back above, so it goes to review with nothing handed over.
    const fresh = await this.loadMove(m.id);
    if (this.refusedTooLong(fresh, now)) {
      return this.toReview(
        fresh,
        `the wallet first refused this move ${this.settings.earningsRefusedReviewAfterHours} hours ago and it has not landed`,
      );
    }
    return this.moveResult(fresh);
  }

  /** Stamps the first refusal, once: a later one finds it set and changes nothing. */
  private async markFirstRefusal(id: string, now: Date): Promise<void> {
    await this.prisma.earningMove.updateMany({
      where: { id, firstRefusedAt: null },
      data: { firstRefusedAt: now },
    });
  }

  /**
   * When to look at a refused move next: after its rest, but never later than
   * the moment 72 hours after its first refusal, so a person is put in front
   * of it on time and not up to an hour after.
   */
  private nextLookAfterRefusal(
    now: Date,
    restMsValue: number,
    firstRefusedAt: Date | null,
  ): Date {
    let next = now.getTime() + restMsValue;
    if (firstRefusedAt) {
      const due = firstRefusedAt.getTime() + this.refusedReviewMs();
      if (due > now.getTime() && due < next) next = due;
    }
    return new Date(next);
  }

  private refusedReviewMs(): number {
    return this.settings.earningsRefusedReviewAfterHours * HOUR;
  }

  /**
   * Whether the wallet first refused this move at least the review bound ago
   * (R-55) and nothing has been handed over since. Counted from the FIRST
   * refusal; a later one never restarts it.
   */
  private refusedTooLong(m: MoveRow, now: Date): boolean {
    return (
      !!m.firstRefusedAt &&
      !m.sentAt &&
      now.getTime() - m.firstRefusedAt.getTime() >= this.refusedReviewMs()
    );
  }

  /** The provider confirmed the move in its answer. */
  private async afterReceipt(
    m: MoveRow,
    receipt: ProviderTransferReceipt,
    now: Date,
  ): Promise<EarningMoveResult> {
    if (receipt.amountKobo !== m.amountKobo) {
      // It moved another amount than asked: a stop. The ledger is not
      // written with a figure we did not ask for; a person looks.
      return this.toReview(
        m,
        `${this.provider.label} moved ${receipt.amountKobo} kobo for a move of ${m.amountKobo} kobo`,
      );
    }
    return this.land(
      m,
      {
        feeKobo: receipt.feeKobo,
        refs: {
          fintavaReference: receipt.providerReference,
          tagapayTransRef: receipt.secondaryReference,
          fintavaTransactionId: receipt.transactionId,
        },
        occurredAt: null,
      },
      now,
    );
  }

  // -------------------------------------------------------------------------
  // Asking the provider about a move that was handed over
  // -------------------------------------------------------------------------

  private async reconcile(m: MoveRow, now: Date): Promise<EarningMoveResult> {
    let answer: ProviderReconciliation | null = null;
    try {
      answer = await this.provider.reconcileSend(
        m.customerReference,
        { kind: 'merchant' },
        m.sentAt ?? m.createdAt,
      );
    } catch (e) {
      this.logger.warn(
        `earning move ${m.id}: ${this.provider.label} could not be asked (${e instanceof WalletProviderError ? e.kind : 'error'})`,
      );
    }
    if (answer?.state === 'found') {
      const t = answer.transaction;
      if (t.outcome === 'completed') {
        if (t.amountKobo !== m.amountKobo) {
          return this.toReview(
            m,
            `${this.provider.label} moved ${t.amountKobo} kobo for a move of ${m.amountKobo} kobo`,
          );
        }
        const tagapay =
          t.secondaryReference ??
          (await this.provider.secondaryReferenceOf(t).catch(() => null));
        return this.land(
          m,
          {
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
          },
          now,
        );
      }
      if (t.outcome === 'failed') {
        // The provider's own record: the move did not happen and the money
        // is where it was. Only this starts a new try, under a new reference.
        return this.retryAfterFailure(m, now);
      }
      if (t.outcome === 'reversed') {
        return this.toReview(
          m,
          `${this.provider.label} moved the earnings and then reversed it; WAWU's account holds the money again`,
        );
      }
      // Pending, or a word we do not know: neither says no money moved.
    }
    return this.stillUnknown(m, now);
  }

  /** Still unknown: asked again, or sent to a person past the bound. */
  private async stillUnknown(
    m: MoveRow,
    now: Date,
  ): Promise<EarningMoveResult> {
    const since = (m.sentAt ?? m.createdAt).getTime();
    if (now.getTime() - since >= this.settings.reviewAfterHours * HOUR) {
      return this.toReview(
        m,
        `no answer from ${this.provider.label} about the move after ${this.settings.reviewAfterHours} hours; it may have moved`,
      );
    }
    await this.schedule(m, now, m.checks + 1);
    return this.moveResult(await this.loadMove(m.id));
  }

  /** The next question to the provider, with the rest doubling each time. */
  private async schedule(m: MoveRow, now: Date, checks: number): Promise<void> {
    await this.prisma.earningMove.updateMany({
      where: { id: m.id, status: 'owed' },
      data: {
        checks: { increment: 1 },
        nextAttemptAt: new Date(now.getTime() + restMs(checks)),
      },
    });
  }

  /** The provider's record says the move failed: a new try, a new reference. */
  private async retryAfterFailure(
    m: MoveRow,
    now: Date,
  ): Promise<EarningMoveResult> {
    const attempt = m.attempt + 1;
    this.logger.warn(
      `earning move ${m.id}: ${this.provider.label} says the move failed; trying again as attempt ${attempt}`,
    );
    // A move the provider failed is a refusal for the 72 hours (R-55): the
    // first one starts the count, a later one leaves it where it is.
    await this.markFirstRefusal(m.id, now);
    const first = (await this.loadMove(m.id)).firstRefusedAt;
    await this.prisma.earningMove.updateMany({
      where: {
        id: m.id,
        status: 'owed',
        sentAt: { not: null },
        customerReference: m.customerReference,
      },
      data: {
        attempt,
        customerReference: moveReference(m.payeeWawuUserId, m.dayKey, attempt),
        sentAt: null,
        checks: 0,
        waiting: 'refused',
        nextAttemptAt: this.nextLookAfterRefusal(now, restMs(attempt), first),
      },
    });
    return this.moveResult(await this.loadMove(m.id));
  }

  // -------------------------------------------------------------------------
  // Landing
  // -------------------------------------------------------------------------

  /**
   * The provider confirmed the move: the ledger gets both sides, the move
   * becomes `landed` with every earning in it, and each sale's payee share is
   * marked paid, all in one write so they never disagree.
   */
  private async land(
    m: MoveRow,
    fig: {
      feeKobo: bigint | null;
      refs: {
        fintavaReference?: string | null;
        tagapayTransRef?: string | null;
        fintavaTransactionId?: string | null;
      };
      occurredAt: Date | null;
    },
    now: Date,
  ): Promise<EarningMoveResult> {
    // A negative charge is nothing a provider charges: the move stands, the
    // charge is not recorded as a figure, and the move says why.
    const fee = fig.feeKobo !== null && fig.feeKobo >= 0n ? fig.feeKobo : null;
    await this.writeLedger(m, fee, fig.refs, fig.occurredAt);
    await this.prisma.$transaction(async (tx) => {
      // The sales' rows first, then the earnings', then the move's: the order
      // the lease takes them in (it reads the sales FOR SHARE, then writes the
      // move), so the callers never wait on each other. Marking a sale that
      // another caller already marked changes nothing.
      const members = await tx.earningSettlement.findMany({
        where: { moveId: m.id },
        select: { paymentId: true },
      });
      await tx.walletPayment.updateMany({
        where: {
          id: {
            in: members.flatMap((x) => (x.paymentId ? [x.paymentId] : [])),
          },
          payeeSettledAt: null,
        },
        data: { payeeSettledAt: now },
      });
      await tx.earningSettlement.updateMany({
        where: { moveId: m.id, status: 'owed' },
        data: {
          status: 'landed',
          settledAt: now,
          destinationAccountNumber: m.destinationAccountNumber,
          sentAt: m.sentAt ?? now,
          waiting: null,
          nextAttemptAt: null,
        },
      });
      await tx.earningMove.updateMany({
        where: { id: m.id, status: 'owed' },
        data: {
          status: 'landed',
          settledAt: now,
          providerFeeKobo: fee,
          waiting: null,
          nextAttemptAt: null,
          ...(fig.feeKobo !== null && fee === null
            ? {
                discrepancy: joinNotes(
                  m.discrepancy,
                  `${this.provider.label} reported a charge of ${fig.feeKobo} kobo on the move`,
                ),
              }
            : {}),
        },
      });
    });
    return this.moveResult(await this.loadMove(m.id));
  }

  /**
   * Both sides of the move in the ledger: WAWU's account (money out) and the
   * person's wallet (money in), category `earning`, under our reference, one
   * pair for the whole move (what the provider moved). A move of a single
   * sale keeps that sale's link and names its payer, as before; a move of
   * several is linked to none of them and comes from WAWU. Best effort, like
   * every ledger write after the money moved: the signed delivery and the
   * status check write them too, and the move's own state is the provider's
   * record.
   */
  private async writeLedger(
    m: MoveRow,
    fee: bigint | null,
    refs: {
      fintavaReference?: string | null;
      tagapayTransRef?: string | null;
      fintavaTransactionId?: string | null;
    },
    occurredAt: Date | null,
  ): Promise<void> {
    const dest = m.destinationAccountNumber;
    if (!dest) return;
    const amount = koboNumber(m.amountKobo);
    const members = await this.prisma.earningSettlement.findMany({
      where: { moveId: m.id },
      select: { paymentId: true, kind: true, targetId: true, title: true },
      take: 2,
    });
    const only = members.length === 1 ? members[0] : null;
    const payment = only?.paymentId
      ? await this.prisma.walletPayment.findUnique({
          where: { id: only.paymentId },
          select: { payerWawuUserId: true },
        })
      : null;
    // A host's share of spent credits is no kind of sale to link to.
    const link = only?.paymentId
      ? {
          kind: only.kind as PaymentKind,
          targetId: only.targetId,
          title: only.title,
        }
      : null;
    const common = {
      status: 'completed' as const,
      category: 'earning' as const,
      link,
      narration: EARNING_NARRATION,
      references: { customerReference: m.customerReference, ...refs },
      // Our own move, known to us: the category, link and counterparty are
      // ours to set, however the ledger first heard of it.
      source: 'send' as const,
      ...(occurredAt ? { occurredAt } : {}),
    };
    // What the provider took from WAWU's account on top (R-31). A record that
    // carries no charge (Fintava's lookups) leaves the figures the row holds
    // standing; the schedule's charge only creates a row that is not there.
    const expected = this.expectedFeeKobo(m.amountKobo);
    const takenFee = fee ?? expected ?? 0n;
    const out: LedgerMovementInput = {
      ...common,
      wallet: { kind: 'merchant', accountNumber: m.merchantAccountNumber },
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
        wawuUserId: m.payeeWawuUserId,
        accountNumber: dest,
      },
    };
    const inn: LedgerMovementInput = {
      ...common,
      wallet: {
        kind: 'user',
        wawuUserId: m.payeeWawuUserId,
        accountNumber: dest,
      },
      direction: 'in',
      amountKobo: amount,
      feeKobo: 0,
      totalKobo: amount,
      // A single sale comes from the person who paid for it; if their account
      // is gone, or the move carries several sales, it comes from WAWU. No
      // account number of the other side.
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
          `earning move ${m.id}: the ledger could not record the move (${e instanceof Error ? e.name : 'error'})`,
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
   * and backs off to hourly: a move waiting for a wallet by its age
   * (`walletWaitRestMs`), the rest by the number of tries.
   */
  private async waitFor(
    m: MoveRow,
    waiting: EarningWaiting,
    now: Date,
    slow = false,
  ): Promise<EarningMoveResult> {
    const walletWait = (WALLET_WAITS as readonly string[]).includes(waiting);
    if (m.waiting !== waiting) {
      this.logger.warn(
        `earning move ${m.id}: it waits (${waiting}); the money stays in WAWU's account`,
      );
    }
    // No review bound here: a missing wallet waits for as long as it takes
    // (R-11), and the provider being away is transient. The 72 hours are for
    // a refusal (R-55), and are read where the move is looked at (send).
    await this.prisma.earningMove.updateMany({
      where: { id: m.id, status: 'owed', sentAt: null },
      data: {
        waiting,
        nextAttemptAt: new Date(
          now.getTime() +
            (walletWait
              ? walletWaitRestMs(now.getTime() - m.createdAt.getTime())
              : slow
                ? 60 * MINUTE
                : restMs(Math.max(m.attempts, 1))),
        ),
      },
    });
    return this.moveResult(await this.loadMove(m.id));
  }

  /** Out of the sweep, for a person to look at. The money stays where it is. Set once. */
  private async toReview(m: MoveRow, note: string): Promise<EarningMoveResult> {
    const { count } = await this.prisma.earningMove.updateMany({
      where: { id: m.id, status: 'owed', reviewSince: null },
      data: {
        reviewSince: new Date(),
        nextAttemptAt: null,
        discrepancy: joinNotes(m.discrepancy, note),
      },
    });
    if (count > 0) {
      this.logger.error(`earning move ${m.id}: ${note}; sent to review`);
    }
    return this.moveResult(await this.loadMove(m.id));
  }

  // -------------------------------------------------------------------------
  // What the caller is told
  // -------------------------------------------------------------------------

  private moveState(m: MoveRow): EarningSettlementState {
    if (m.status === 'landed') return 'landed';
    if (m.reviewSince) return 'review';
    if (m.sentAt) return 'pending';
    return 'waiting';
  }

  private moveResult(m: MoveRow): EarningMoveResult {
    const state = this.moveState(m);
    return {
      moveId: m.id,
      payeeWawuUserId: m.payeeWawuUserId,
      state,
      waiting:
        state === 'waiting'
          ? ((m.waiting as EarningWaiting | null) ?? null)
          : null,
      status: m.status as EarningStatus,
      amountKobo: m.amountKobo,
      earnings: m.earnings,
    };
  }

  /** An earning, as its move says: the move's state, or `waiting` for the next move. */
  private async settlementResult(
    s: SettlementRow,
  ): Promise<EarningSettlementResult> {
    const move = s.moveId
      ? await this.prisma.earningMove.findUnique({ where: { id: s.moveId } })
      : null;
    let state: EarningSettlementState;
    if (s.status === 'landed') state = 'landed';
    else if (s.reviewSince || move?.reviewSince) state = 'review';
    else if (move?.sentAt) state = 'pending';
    else state = 'waiting';
    return {
      settlementId: s.id,
      paymentId: s.paymentId,
      state,
      waiting:
        state === 'waiting'
          ? (((move?.waiting ?? s.waiting) as EarningWaiting | null) ?? null)
          : null,
      status: s.status as EarningStatus,
    };
  }
}
