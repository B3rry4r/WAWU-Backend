import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { rowsOf } from '../../wallet-provider/provider-rows';
import {
  type ProviderHolder,
  type ProviderPlatformAccount,
  type ProviderTransaction,
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import { WalletProviderError } from '../../wallet-provider/wallet-provider-error';
import { ledgerConfirmWindowMs } from '../ledger/ledger-config';
import { LEDGER_ABSENT_FAILURE } from '../ledger/ledger.service';
import { PaymentSettings } from '../payments/payment-config';
import {
  compareBalance,
  compareMerchantCharge,
  compareMovements,
  type LedgerGroup,
  type LedgerOutRow,
  type LedgerSums,
  requiredInAccount,
  sameLedger,
  sumLedger,
} from './money-check-compare';
import {
  RUN_ATTEMPTS,
  RUN_LEASE_MS,
  RUN_RETRY_GAP_MS,
  MoneyCheckSettings,
} from './money-check-config';
import {
  checkHeldRecords,
  checkHolds,
  checkLedgerRows,
  checkPayments,
  type DbCheckContext,
} from './money-check-db';
import {
  mailOf,
  MoneyCheckMailer,
  MoneyCheckMailRefused,
  plainRef,
} from './money-check-mailer';
import { MoneyCheckScope } from './money-check-scope';
import { FindingSink } from './money-check-sink';
import { isNight, lagosMinuteOfDay, lagosNight } from './money-check-time';
import {
  CHECK_IDS,
  type CheckId,
  type Finding,
  type MoneyCheckReport,
  type Verdict,
  type WalletSkip,
} from './money-check-types';

const HOUR = 3_600_000;
const MINUTE = 60_000;

/**
 * How far past the start of the window the provider's history is read before
 * it is called read in full: the ledger's time for a movement (the provider's
 * own time, when it gave one) and the provider's listing can differ by a few
 * seconds, and a row on the edge must find its pair.
 */
const HISTORY_MARGIN_MS = 6 * HOUR;

/** Provider failures worth asking again about before a wallet is given up on. */
const ASK_AGAIN = new Set(['rate_limited', 'unavailable', 'bad_response']);
/** Provider failures that mean nothing more can be read this run. */
const NO_POINT_GOING_ON = new Set([
  'auth',
  'not_configured',
  'merchant_inactive',
]);

const sleep = (ms: number): Promise<void> =>
  ms > 0
    ? new Promise((resolve) => setTimeout(resolve, ms))
    : Promise.resolve();

/** The run was taken over by another process while this one worked. */
class RunLostError extends Error {
  constructor() {
    super('money check: another process took this run');
    this.name = 'RunLostError';
  }
}

export interface RunOptions {
  /** The Lagos date the run belongs to. Default: today's. */
  night?: string;
  now?: Date;
  /**
   * A person asked for it: the time of day, the catch-up window and the
   * limit on tries do not apply.
   */
  byHand?: boolean;
  /** Make another run for a night that has already finished. */
  again?: boolean;
  /** Where the movement comparison starts. Default: from the last finished run. */
  windowFrom?: Date | null;
}

export type RunOutcome =
  | {
      state: 'finished';
      runId: string;
      verdict: Verdict;
      report: MoneyCheckReport;
    }
  | { state: 'already_done'; runId: string }
  | { state: 'busy'; runId: string }
  | { state: 'failed'; runId: string; why: string }
  | { state: 'given_up'; runId: string; verdict: Verdict };

interface ClaimedRun {
  id: string;
  attempt: number;
  startedAt: Date;
  night: string;
  byHand: boolean;
}

interface WalletRef {
  wawuUserId: string;
  customerId: string;
  walletId: string;
  accountNumber: string;
}

interface FeeCandidate {
  rowId: string;
  providerId: string;
  expectedKobo: bigint;
}

interface RunState {
  run: ClaimedRun;
  now: Date;
  windowFrom: Date | null;
  windowTo: Date;
  deadline: number;
  sink: FindingSink;
  wallets: MoneyCheckReport['wallets'];
  unsupported: { balance: boolean; history: boolean };
  unreadable: {
    balance: number;
    history: number;
    moving: number;
    long: number;
  };
  stopped: boolean;
  feeCandidates: FeeCandidate[];
}

/** The ledger rows of a wallet's history comparison, with the references each is known by. */
const OUT_ROW = {
  id: true,
  status: true,
  amountKobo: true,
  wawuFeeKobo: true,
  occurredAt: true,
  createdAt: true,
  customerReference: true,
  fintavaReference: true,
  tagapayTransRef: true,
  fintavaTransactionId: true,
  sessionId: true,
  linkKind: true,
  references: { select: { value: true } },
} satisfies Prisma.FintavaLedgerEntrySelect;

type OutRow = Prisma.FintavaLedgerEntryGetPayload<{ select: typeof OUT_ROW }>;

function toOutRow(r: OutRow): LedgerOutRow {
  const refs = new Set<string>();
  for (const v of [
    r.customerReference,
    r.fintavaReference,
    r.tagapayTransRef,
    r.fintavaTransactionId,
    r.sessionId,
    ...r.references.map((x) => x.value),
  ]) {
    if (typeof v === 'string' && v !== '') refs.add(v);
  }
  return {
    id: r.id,
    status: r.status,
    amountKobo: r.amountKobo,
    // A bill's WAWU fee rides inside the amount moved into WAWU's account; it
    // is not a charge the provider takes, so there is none to find on its record.
    wawuFeeKobo: r.linkKind === 'bill' ? null : r.wawuFeeKobo,
    occurredAt: r.occurredAt,
    createdAt: r.createdAt,
    refs: [...refs],
  };
}

/**
 * The nightly check against the wallet provider (task MONEY-16).
 *
 * Any difference between WAWU's ledger and the provider's own record is found
 * the same night and reported by email (through WAWU ID, see
 * `MoneyCheckMailer`). It compares:
 * - every wallet's debits, from the provider's history, with the ledger's
 *   `out` rows, and WAWU's own account's the same way;
 * - every wallet's balance with what the ledger says it should be;
 * - the money held for payers and payees (R-19) with the provider's balance
 *   of WAWU's account, and every hold with the ledger rows it should have
 *   left;
 * - WAWU's own charge on each send that carries one (R-10, OPS-09) with what
 *   the provider's record of the send shows it paid to WAWU.
 * Besides, it lists what a person has to look at: payments in review (silence
 * from the provider never ends a payment), holds in review or waiting past
 * their limits, money owed to a deleted payee, and the stops the ledger left.
 * Counts and references only.
 *
 * It only reads and reports. It never changes a ledger row, a hold, a payment
 * or a balance: the provider's balance is the truth, and what to do about a
 * difference is a person's call.
 *
 * It reaches the provider only through the seam (`WALLET_PROVIDER`) and acts
 * only on the rows of the provider this server runs. What a provider's adapter
 * cannot answer yet (`not_supported`) is reported as not checked, never as
 * clean.
 *
 * Safe on two Hub processes: a run is claimed by inserting its row
 * (`MoneyCheckRun`, unique per provider, night and sequence), so only one
 * process makes a night's run. A run that dies is taken over after its lease
 * (10 minutes without a heartbeat) and made again, at most three times a
 * night; a night that cannot finish is reported as not finished, never as
 * clean. Run by hand with `npm run money:check`.
 */
@Injectable()
export class MoneyCheckService {
  private readonly logger = new Logger(MoneyCheckService.name);
  private ticking = false;
  private readonly confirmWindowMs: number;
  /** The night this process has seen finished, so the minute tick asks no more. */
  private doneNight: string | null = null;
  private warnedNoRecipients = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(WALLET_PROVIDER) private readonly provider: WalletProvider,
    config: ConfigService,
    private readonly settings: MoneyCheckSettings,
    private readonly payments: PaymentSettings,
    private readonly mailer: MoneyCheckMailer,
    private readonly scope: MoneyCheckScope,
  ) {
    this.confirmWindowMs = ledgerConfirmWindowMs(
      config.get<string>('LEDGER_CONFIRM_WINDOW_HOURS'),
    );
  }

  // -------------------------------------------------------------------------
  // The schedule
  // -------------------------------------------------------------------------

  /**
   * Every minute: start tonight's run when its time has come and nobody has
   * made it, and hand on any finished report that has not reached WAWU ID.
   * Where `ScheduleModule.forRoot()` is not loaded (a spec, the by-hand
   * command) nothing calls this.
   */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'money-nightly-check' })
  async tick(now = new Date()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const night = this.dueNight(now);
      if (night !== null && night !== this.doneNight) {
        const outcome = await this.runNight({ night, now });
        if (
          outcome.state === 'finished' ||
          outcome.state === 'already_done' ||
          outcome.state === 'given_up'
        ) {
          this.doneNight = night;
        }
      }
      await this.closeStale(now);
      await this.sendDue(now);
    } catch (e) {
      this.logger.error(
        `money check tick failed: ${e instanceof Error ? e.name : 'error'}`,
      );
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Closes any run whose last try died and that nothing will make again
   * (round 2, VF-3): a `running` row whose process is gone, or a `failed`
   * row whose rest is over. The night ends `incomplete`, mailed like any
   * other, at any hour: a night is never left `running` because the catch-up
   * window passed.
   *
   * It runs AFTER the tick has tried tonight's run, so a row of the night
   * being made, with tries left, has already been taken over and made again
   * by then; what is left to close is what nothing will make again.
   *
   * Left alone: a lease that has not run out, and a run a person made by hand
   * that failed (they saw the failure and run it again, or ask for `--again`).
   */
  async closeStale(now: Date): Promise<void> {
    try {
      const stale = await this.prisma.moneyCheckRun.findMany({
        where: {
          provider: this.provider.name,
          status: { in: ['running', 'failed'] },
          leaseUntil: { lte: now },
          NOT: { status: 'failed', byHand: true },
        },
        orderBy: [{ night: 'asc' }, { sequence: 'asc' }],
        take: 20,
        select: {
          id: true,
          attempt: true,
          night: true,
          startedAt: true,
          status: true,
          failure: true,
        },
      });
      for (const r of stale) {
        await this.giveUp(
          r.id,
          r.attempt,
          r.night,
          r.startedAt,
          now,
          r.status === 'failed' ? storedFailure(r.failure) : RUN_DIED,
        );
      }
    } catch (e) {
      this.logger.error(
        `money check: closing old runs failed (${e instanceof Error ? e.name : 'error'})`,
      );
    }
  }

  /** The night whose run is due now, or null: off, too early, or too late. */
  dueNight(now: Date): string | null {
    const start = this.settings.minuteOfDay;
    if (start === null) return null;
    const since = lagosMinuteOfDay(now) - start;
    if (since < 0 || since * MINUTE > this.settings.catchUpMs) return null;
    return lagosNight(now);
  }

  // -------------------------------------------------------------------------
  // One run
  // -------------------------------------------------------------------------

  /**
   * Makes the night's run if nobody has: claims it, compares, stores the
   * report and hands it to WAWU ID. Safe to call again and from two
   * processes: a night is made once.
   */
  async runNight(opts: RunOptions = {}): Promise<RunOutcome> {
    const now = opts.now ?? new Date();
    const night = opts.night ?? lagosNight(now);
    if (!isNight(night)) {
      throw new RangeError('The night must be a date such as 2026-10-12.');
    }
    const claim = await this.claim(night, now, opts);
    if ('outcome' in claim) return claim.outcome;
    const run = claim.run;
    try {
      const windowTo = run.startedAt;
      const windowFrom = await this.windowFrom(run, windowTo, opts);
      const report = await this.execute(run, windowFrom, windowTo);
      const stored = await this.finish(run, report);
      if (!stored) return { state: 'busy', runId: run.id };
      this.announce(report);
      await this.afterwards(run.id, now);
      return {
        state: 'finished',
        runId: run.id,
        verdict: report.verdict,
        report,
      };
    } catch (e) {
      if (e instanceof RunLostError) return { state: 'busy', runId: run.id };
      return this.fail(run, e, opts, now);
    }
  }

  /**
   * What follows a stored run: handing the report on and forgetting old runs.
   * The run is already finished and kept, so a failure here is logged and
   * left to the minute tick, which hands on any report that has not reached
   * everyone.
   */
  private async afterwards(runId: string, now: Date): Promise<void> {
    try {
      await this.deliver(runId);
      await this.prune(now);
    } catch (e) {
      this.logger.error(
        `money check: the finished run ${runId} was not handed on (${logReason(e)})`,
      );
    }
  }

  private async claim(
    night: string,
    now: Date,
    opts: RunOptions,
  ): Promise<{ run: ClaimedRun } | { outcome: RunOutcome }> {
    const provider = this.provider.name;
    const last = await this.prisma.moneyCheckRun.findFirst({
      where: { provider, night },
      orderBy: { sequence: 'desc' },
      select: { id: true, sequence: true, status: true },
    });
    if (last?.status === 'finished' && !opts.again) {
      return { outcome: { state: 'already_done', runId: last.id } };
    }
    const sequence = last
      ? last.status === 'finished'
        ? last.sequence + 1
        : last.sequence
      : 1;
    const byHand = opts.byHand === true;
    const leaseUntil = new Date(now.getTime() + RUN_LEASE_MS);
    const id = randomUUID();
    const { count } = await this.prisma.moneyCheckRun.createMany({
      data: [
        {
          id,
          provider,
          night,
          sequence,
          status: 'running',
          attempt: 1,
          byHand,
          startedAt: now,
          leaseUntil,
        },
      ],
      skipDuplicates: true,
    });
    if (count === 1) {
      return { run: { id, attempt: 1, startedAt: now, night, byHand } };
    }
    const row = await this.prisma.moneyCheckRun.findUnique({
      where: { provider_night_sequence: { provider, night, sequence } },
    });
    if (!row) return { outcome: { state: 'busy', runId: id } };
    if (row.status === 'finished') {
      return { outcome: { state: 'already_done', runId: row.id } };
    }
    if (row.leaseUntil.getTime() > now.getTime()) {
      return { outcome: { state: 'busy', runId: row.id } };
    }
    if (!byHand && row.attempt >= RUN_ATTEMPTS) {
      return {
        outcome: await this.giveUp(
          row.id,
          row.attempt,
          night,
          row.startedAt,
          now,
          row.status === 'failed' ? storedFailure(row.failure) : RUN_DIED,
        ),
      };
    }
    const taken = await this.prisma.moneyCheckRun.updateMany({
      where: {
        id: row.id,
        attempt: row.attempt,
        status: { in: ['running', 'failed'] },
        leaseUntil: { lte: now },
      },
      data: {
        status: 'running',
        attempt: row.attempt + 1,
        startedAt: now,
        leaseUntil,
        failure: null,
        byHand: byHand || row.byHand,
      },
    });
    if (taken.count !== 1) return { outcome: { state: 'busy', runId: row.id } };
    return {
      run: {
        id: row.id,
        attempt: row.attempt + 1,
        startedAt: now,
        night,
        byHand,
      },
    };
  }

  /** Keeps the lease on a run; a run another process took is dropped. */
  private async beat(run: ClaimedRun): Promise<void> {
    const { count } = await this.prisma.moneyCheckRun.updateMany({
      where: { id: run.id, status: 'running', attempt: run.attempt },
      data: { leaseUntil: new Date(Date.now() + RUN_LEASE_MS) },
    });
    if (count !== 1) throw new RunLostError();
  }

  /**
   * Where the movement comparison starts: back past the last finished run's
   * window by the overlap (a row that settled late is compared again), and
   * never further than the look-back limit. Balances are cumulative, so what
   * is older is still covered.
   */
  private async windowFrom(
    run: ClaimedRun,
    to: Date,
    opts: RunOptions,
  ): Promise<Date | null> {
    if (opts.windowFrom !== undefined) return opts.windowFrom;
    const floor = new Date(to.getTime() - this.settings.lookbackMs);
    const prev = await this.prisma.moneyCheckRun.findFirst({
      where: {
        provider: this.provider.name,
        status: 'finished',
        verdict: { in: ['clean', 'needs_a_look', 'differences'] },
        windowTo: { not: null },
        id: { not: run.id },
      },
      orderBy: { windowTo: 'desc' },
      select: { windowTo: true },
    });
    if (!prev?.windowTo) return floor;
    const from = new Date(prev.windowTo.getTime() - this.settings.overlapMs);
    return from.getTime() > floor.getTime() ? from : floor;
  }

  private async finish(
    run: ClaimedRun,
    report: MoneyCheckReport,
  ): Promise<boolean> {
    const finishedAt = new Date(report.finishedAt);
    const { count } = await this.prisma.moneyCheckRun.updateMany({
      where: { id: run.id, status: 'running', attempt: run.attempt },
      data: {
        status: 'finished',
        finishedAt,
        windowFrom: report.windowFrom ? new Date(report.windowFrom) : null,
        windowTo: new Date(report.windowTo),
        verdict: report.verdict,
        walletsTotal: report.wallets.total,
        walletsChecked: report.wallets.checked,
        mismatchCount: this.countOf(report, 'mismatch'),
        lookCount: this.countOf(report, 'look'),
        report: report as unknown as Prisma.InputJsonValue,
        failure: null,
        leaseUntil: finishedAt,
        emailedTo: [],
        nextEmailAt: finishedAt,
      },
    });
    return count === 1;
  }

  private countOf(
    report: MoneyCheckReport,
    severity: 'mismatch' | 'look',
  ): number {
    return severity === 'mismatch'
      ? report.mismatches.length + report.omitted.mismatches
      : report.look.length + report.omitted.look;
  }

  private async fail(
    run: ClaimedRun,
    e: unknown,
    opts: RunOptions,
    now: Date,
  ): Promise<RunOutcome> {
    const failure = failureOf(e);
    this.logger.error(
      `money check ${run.night}: try ${run.attempt} failed (${failure.code}${e instanceof Error ? `, ${e.name}` : ''})`,
    );
    if (!run.byHand && run.attempt >= RUN_ATTEMPTS) {
      return this.giveUp(
        run.id,
        run.attempt,
        run.night,
        run.startedAt,
        now,
        failure,
      );
    }
    const why = failureText(failure);
    await this.prisma.moneyCheckRun.updateMany({
      where: { id: run.id, status: 'running', attempt: run.attempt },
      data: {
        status: 'failed',
        failure: why,
        leaseUntil: opts.byHand ? now : new Date(Date.now() + RUN_RETRY_GAP_MS),
      },
    });
    return { state: 'failed', runId: run.id, why };
  }

  /**
   * A night that could not be made in the tries it gets ends as `incomplete`
   * with the reason, and is reported like any other: it is never left as
   * nothing, which would read as clean.
   */
  private async giveUp(
    id: string,
    attempt: number,
    night: string,
    startedAt: Date,
    now: Date,
    failure: RunFailure = RUN_DIED,
  ): Promise<RunOutcome> {
    const report = failureReport(
      this.provider.name,
      night,
      startedAt,
      now,
      failure,
    );
    const { count } = await this.prisma.moneyCheckRun.updateMany({
      where: {
        id,
        attempt,
        status: { in: ['running', 'failed'] },
      },
      data: {
        status: 'finished',
        finishedAt: now,
        windowTo: now,
        verdict: 'incomplete',
        walletsTotal: 0,
        walletsChecked: 0,
        mismatchCount: 0,
        lookCount: 0,
        report: report as unknown as Prisma.InputJsonValue,
        failure: failureText(failure),
        leaseUntil: now,
        emailedTo: [],
        nextEmailAt: now,
      },
    });
    if (count === 1) {
      this.announce(report);
      await this.afterwards(id, now);
    }
    return { state: 'given_up', runId: id, verdict: 'incomplete' };
  }

  /** The night's result in the log, where the owner's tools can see it. */
  private announce(report: MoneyCheckReport): void {
    const line =
      `money check ${report.night} (${report.provider}): ${report.verdict}; ` +
      `${report.wallets.checked} of ${report.wallets.total} wallets checked; ` +
      `${this.countOf(report, 'mismatch')} mismatches, ${this.countOf(report, 'look')} to look at`;
    if (report.verdict === 'clean') {
      this.logger.log(line);
      return;
    }
    this.logger.error(line);
    for (const f of [...report.mismatches, ...report.look].slice(0, 50)) {
      this.logger.error(findingLogLine(report.night, f));
    }
  }

  // -------------------------------------------------------------------------
  // The comparisons
  // -------------------------------------------------------------------------

  private async execute(
    run: ClaimedRun,
    windowFrom: Date | null,
    windowTo: Date,
  ): Promise<MoneyCheckReport> {
    const now = windowTo;
    const sink = new FindingSink();
    const st: RunState = {
      run,
      now,
      windowFrom,
      windowTo,
      deadline: Date.now() + this.settings.maxRunMs,
      sink,
      wallets: { total: 0, checked: 0, notChecked: {} },
      unsupported: { balance: false, history: false },
      unreadable: { balance: 0, history: 0, moving: 0, long: 0 },
      stopped: false,
      feeCandidates: [],
    };
    const held = {
      openCount: 0,
      openKobo: 0n,
      requiredKobo: 0n,
      merchantAvailableKobo: null as bigint | null,
    };

    const wallets = await this.prisma.fintavaWallet.findMany({
      where: { AND: [rowsOf(this.provider.name), this.scope.walletWhere()] },
      select: {
        wawuUserId: true,
        customerId: true,
        walletId: true,
        accountNumber: true,
      },
      orderBy: { wawuUserId: 'asc' },
    });
    st.wallets.total = wallets.length;

    if (!this.provider.configured) {
      this.notSetUp(st, wallets.length);
    } else {
      await this.walletLoop(st, wallets);
      await this.merchantSide(st, held);
      await this.feeCharges(st);
    }

    await this.beat(run);
    const db: DbCheckContext = {
      prisma: this.prisma,
      provider: this.provider.name,
      scope: this.scope,
      now,
      windowFrom,
      confirmWindowMs: this.confirmWindowMs,
      reviewAfterMs: this.payments.reviewAfterHours * HOUR,
      settleMs: this.settings.settleMs,
      sink,
    };
    await checkLedgerRows(db);
    await this.beat(run);
    await checkPayments(db);
    await checkHolds(db);
    await this.beat(run);
    await checkHeldRecords(db);
    await this.heldFigures(held);
    await this.nameNewWallets(st, wallets);

    return this.assemble(st, held);
  }

  /**
   * A wallet opened while the run was going is not in the list it read at the
   * start, so "N of N" does not count it and nothing compared it. It is named
   * in the report instead of being left out silently; tomorrow's run reads it
   * (round 2, VF-5).
   */
  private async nameNewWallets(
    st: RunState,
    snapshot: readonly WalletRef[],
  ): Promise<void> {
    const had = new Set(snapshot.map((w) => w.wawuUserId));
    const PAGE = 5000;
    let opened = 0;
    let after: string | undefined;
    for (;;) {
      const page = await this.prisma.fintavaWallet.findMany({
        where: {
          AND: [
            rowsOf(this.provider.name),
            this.scope.walletWhere(),
            ...(after === undefined ? [] : [{ wawuUserId: { gt: after } }]),
          ],
        },
        select: { wawuUserId: true },
        orderBy: { wawuUserId: 'asc' },
        take: PAGE,
      });
      for (const w of page) if (!had.has(w.wawuUserId)) opened += 1;
      if (page.length < PAGE) break;
      after = page[page.length - 1].wawuUserId;
    }
    st.sink.notice('wallets_opened_during_run', opened);
  }

  /** The provider is not set up here: nothing can be compared with it. */
  private notSetUp(st: RunState, wallets: number): void {
    const note = `Not checked: ${this.provider.label} is not set up on this server.`;
    for (const id of [
      'movements',
      'merchant_movements',
      'balances',
      'merchant_charges',
    ] as const) {
      st.sink.cannot(id, 'not_checked', note);
    }
    st.sink.cannot('held_money', 'incomplete', note);
    if (wallets > 0) st.wallets.notChecked.not_set_up = wallets;
  }

  private async walletLoop(
    st: RunState,
    wallets: readonly WalletRef[],
  ): Promise<void> {
    for (const w of wallets) {
      if (st.stopped || Date.now() > st.deadline) {
        st.wallets.notChecked.not_reached =
          (st.wallets.notChecked.not_reached ?? 0) + 1;
        continue;
      }
      await this.beat(st.run);
      let skip: WalletSkip | null = null;

      if (st.unsupported.balance) skip = 'not_supported';
      else {
        try {
          if ((await this.checkBalance(st, w)) === 'moving') {
            st.unreadable.moving += 1;
            skip = 'moving';
          }
        } catch (e) {
          skip = this.skipOf(st, e, 'balance');
        }
      }

      if (st.unsupported.history) skip ??= 'not_supported';
      else {
        try {
          if (!(await this.checkMovements(st, w))) {
            st.unreadable.long += 1;
            skip ??= 'history_incomplete';
          }
        } catch (e) {
          const why = this.skipOf(st, e, 'history');
          skip ??= why;
        }
      }

      if (skip === null) st.wallets.checked += 1;
      else st.wallets.notChecked[skip] = (st.wallets.notChecked[skip] ?? 0) + 1;
    }

    const { sink, unsupported, unreadable } = st;
    if (unsupported.balance) {
      sink.cannot(
        'balances',
        'not_checked',
        `Not checked on this provider: ${this.provider.label} cannot be asked for a wallet balance yet.`,
      );
    }
    if (unsupported.history) {
      sink.cannot(
        'movements',
        'not_checked',
        `Not checked on this provider: ${this.provider.label} cannot list a wallet's debits yet.`,
      );
    }
    if (unreadable.balance > 0 || unreadable.moving > 0) {
      sink.cannot(
        'balances',
        'incomplete',
        `${unreadable.balance} wallets could not be read and ${unreadable.moving} kept moving while they were read.`,
      );
    }
    if (unreadable.history > 0 || unreadable.long > 0) {
      sink.cannot(
        'movements',
        'incomplete',
        `${unreadable.history} wallets could not be read and ${unreadable.long} have a history longer than the pages read.`,
      );
    }
    if (st.stopped || (st.wallets.notChecked.not_reached ?? 0) > 0) {
      for (const id of ['movements', 'balances'] as const) {
        sink.cannot(
          id,
          'incomplete',
          'The run stopped before every wallet was reached.',
        );
      }
    }
  }

  /** What a wallet's provider failure means for the run. Anything else is a bug. */
  private skipOf(
    st: RunState,
    e: unknown,
    what: 'balance' | 'history',
  ): WalletSkip {
    if (!(e instanceof WalletProviderError)) throw e;
    if (e.kind === 'not_supported') {
      st.unsupported[what] = true;
      return 'not_supported';
    }
    if (NO_POINT_GOING_ON.has(e.kind)) st.stopped = true;
    st.unreadable[what] += 1;
    this.logger.warn(
      `money check ${st.run.night}: a wallet's ${what} could not be read (${e.kind})`,
    );
    return 'unreadable';
  }

  /** One provider read, asked again when the provider says to wait. */
  private async ask<T>(op: () => Promise<T>): Promise<T> {
    for (let i = 0; ; i += 1) {
      await sleep(this.settings.callGapMs);
      try {
        return await op();
      } catch (e) {
        if (
          !(e instanceof WalletProviderError) ||
          !ASK_AGAIN.has(e.kind) ||
          i >= this.settings.retryMs.length
        ) {
          throw e;
        }
        await sleep(this.settings.retryMs[i]);
      }
    }
  }

  private async ledgerSums(accountNumber: string): Promise<LedgerSums> {
    const name = this.provider.name;
    const rows = await this.prisma.$queryRaw<
      Array<{
        direction: string;
        status: string;
        uncertain: boolean;
        total: string;
        n: number;
        touched: Date | null;
      }>
    >`
      SELECT "direction"::text AS direction,
             "status"::text AS status,
             COALESCE("status" = 'failed' AND "direction" = 'out'
               AND "reversedAt" IS NULL
               AND "counterpartyKind" = 'bank_account'
               AND "failureReason" IS DISTINCT FROM ${LEDGER_ABSENT_FAILURE}, false) AS uncertain,
             COALESCE(SUM("totalKobo"), 0)::text AS total,
             COUNT(*)::int AS n,
             MAX("updatedAt") AS touched
        FROM "FintavaLedgerEntry"
       WHERE "walletKind" = 'user'
         AND "accountNumber" = ${accountNumber}
         AND ("provider" = ${name} OR (${name} = 'fintava' AND "provider" IS NULL))
       GROUP BY 1, 2, 3`;
    const groups: LedgerGroup[] = rows.map((r) => ({
      direction: r.direction === 'in' ? 'in' : 'out',
      status: r.status as LedgerGroup['status'],
      uncertain: r.uncertain,
      totalKobo: BigInt(r.total),
      rows: r.n,
      touchedMs: r.touched ? r.touched.getTime() : null,
    }));
    return sumLedger(groups);
  }

  /**
   * A wallet's balance at the provider against the ledger. A difference is
   * reported only when the ledger stood still while the provider was asked,
   * twice running; a wallet that kept moving is not compared.
   */
  private async checkBalance(
    st: RunState,
    w: WalletRef,
  ): Promise<'done' | 'moving'> {
    let confirmed = 0;
    let last: {
      baseKobo: bigint;
      availableKobo: bigint;
      differenceKobo: bigint;
      bookedDiffers: boolean;
    } | null = null;
    const waits = this.settings.recheckMs;
    for (let i = 0; i <= waits.length; i += 1) {
      const before = await this.ledgerSums(w.accountNumber);
      const balance = await this.ask(() =>
        this.provider.getBalance({ walletId: w.walletId }),
      );
      const after = await this.ledgerSums(w.accountNumber);
      if (sameLedger(before, after)) {
        const cmp = compareBalance(after, balance);
        if (cmp.match) {
          st.sink.compared('balances', 1);
          if (cmp.bookedDiffers) st.sink.notice('balance_booked_differs', 1);
          return 'done';
        }
        confirmed += 1;
        last = {
          baseKobo: cmp.baseKobo,
          availableKobo: balance.availableKobo,
          differenceKobo: cmp.differenceKobo,
          bookedDiffers: cmp.bookedDiffers,
        };
        if (confirmed >= 2) break;
      }
      if (i < waits.length) await sleep(waits[i]);
    }
    if (last === null) return 'moving';
    st.sink.compared('balances', 1);
    if (last.bookedDiffers) st.sink.notice('balance_booked_differs', 1);
    const more = last.differenceKobo > 0n;
    st.sink.add({
      check: 'balances',
      severity: 'mismatch',
      kind: 'balance_differs',
      ref: w.walletId,
      detail: `The provider has ${(more ? last.differenceKobo : -last.differenceKobo).toString()} kobo ${more ? 'more' : 'less'} in this wallet than the ledger accounts for.`,
      amountKobo: last.baseKobo.toString(),
      otherKobo: last.availableKobo.toString(),
    });
    return 'done';
  }

  /**
   * The provider's history for a holder, read back to the start of the
   * window. It stops early at a page that reaches before the window only
   * while every page so far has come newest first; a list that is not in
   * that order is read to its end, so a row inside the window is never left
   * behind a row from before it.
   */
  private async history(
    st: RunState,
    holder: ProviderHolder,
  ): Promise<{ rows: ProviderTransaction[]; complete: boolean }> {
    const seen = new Map<string, ProviderTransaction>();
    let newestFirst = true;
    let oldestSeen = Number.POSITIVE_INFINITY;
    const from = st.windowFrom ? st.windowFrom.getTime() : null;
    for (let page = 1; page <= this.settings.historyPages; page += 1) {
      const res = await this.ask(() =>
        this.provider.listTransactions(holder, {
          page,
          take: 100,
          order: 'DESC',
        }),
      );
      const fresh = res.items.filter((t) => !seen.has(t.id));
      for (const t of res.items) seen.set(t.id, t);
      if (res.items.length === 0 || !res.hasNextPage) {
        return { rows: [...seen.values()], complete: true };
      }
      const inOrder = res.items
        .map((t) => Date.parse(t.createdAt))
        .filter((n) => Number.isFinite(n));
      for (let i = 1; i < inOrder.length; i += 1) {
        if (inOrder[i] > inOrder[i - 1]) newestFirst = false;
      }
      const times = fresh
        .map((t) => Date.parse(t.createdAt))
        .filter((n) => Number.isFinite(n));
      if (times.length > 0) {
        if (Math.max(...times) > oldestSeen) newestFirst = false;
        oldestSeen = Math.min(oldestSeen, ...times);
        if (
          from !== null &&
          newestFirst &&
          Math.min(...times) < from - HISTORY_MARGIN_MS
        ) {
          return { rows: [...seen.values()], complete: true };
        }
      }
    }
    return { rows: [...seen.values()], complete: false };
  }

  /** One wallet's debits against the ledger. Returns whether the history was read in full. */
  private async checkMovements(st: RunState, w: WalletRef): Promise<boolean> {
    const loadFrom = st.windowFrom
      ? new Date(st.windowFrom.getTime() - 24 * HOUR)
      : null;
    const rows = await this.prisma.fintavaLedgerEntry.findMany({
      where: {
        AND: [
          rowsOf(this.provider.name),
          {
            walletKind: 'user',
            accountNumber: w.accountNumber,
            direction: 'out',
            ...(loadFrom ? { occurredAt: { gte: loadFrom } } : {}),
          },
        ],
      },
      select: OUT_ROW,
    });
    const hist = await this.history(st, {
      kind: 'customer',
      customerId: w.customerId,
    });
    this.takeMovements(st, 'movements', rows, hist);
    return hist.complete;
  }

  private takeMovements(
    st: RunState,
    check: 'movements' | 'merchant_movements',
    rows: readonly OutRow[],
    hist: { rows: ProviderTransaction[]; complete: boolean },
  ): void {
    const result = compareMovements({
      check,
      ledger: rows.map(toOutRow),
      provider: hist.rows,
      now: st.now,
      settleMs: this.settings.settleMs,
      windowFrom: st.windowFrom,
      historyComplete: hist.complete,
    });
    st.sink.addAll(result.findings);
    st.sink.mergeNotices(result.notices);
    st.sink.compared(check, result.compared);
    for (const { row, provider } of result.matched) {
      if (
        row.status === 'completed' &&
        provider.outcome === 'completed' &&
        row.wawuFeeKobo !== null &&
        row.wawuFeeKobo > 0n
      ) {
        st.feeCandidates.push({
          rowId: row.id,
          providerId: provider.id,
          expectedKobo: row.wawuFeeKobo,
        });
      }
    }
  }

  /**
   * WAWU's own account: its debits against the ledger's merchant rows, and
   * the provider's balance of it against what the open holds need.
   */
  private async merchantSide(
    st: RunState,
    held: {
      requiredKobo: bigint;
      merchantAvailableKobo: bigint | null;
    },
  ): Promise<void> {
    if (st.stopped) {
      for (const id of ['merchant_movements', 'held_money'] as const) {
        st.sink.cannot(
          id,
          'incomplete',
          "The run stopped before WAWU's account was read.",
        );
      }
      return;
    }
    await this.beat(st.run);
    let account: ProviderPlatformAccount;
    try {
      account = await this.ask(() => this.provider.getPlatformAccount());
    } catch (e) {
      if (!(e instanceof WalletProviderError)) throw e;
      const notSupported = e.kind === 'not_supported';
      const note = notSupported
        ? `Not checked on this provider: ${this.provider.label} cannot be asked for WAWU's own account yet.`
        : "WAWU's own account could not be read.";
      st.sink.cannot(
        'merchant_movements',
        notSupported ? 'not_checked' : 'incomplete',
        note,
      );
      st.sink.cannot(
        'held_money',
        notSupported ? 'not_checked' : 'incomplete',
        note,
      );
      return;
    }
    held.merchantAvailableKobo = account.availableKobo;

    // WAWU's debits.
    try {
      const loadFrom = st.windowFrom
        ? new Date(st.windowFrom.getTime() - 24 * HOUR)
        : null;
      const rows = await this.prisma.fintavaLedgerEntry.findMany({
        where: {
          AND: [
            rowsOf(this.provider.name),
            this.scope.ledgerWhere(),
            {
              walletKind: 'merchant',
              direction: 'out',
              ...(loadFrom ? { occurredAt: { gte: loadFrom } } : {}),
            },
          ],
        },
        select: OUT_ROW,
      });
      const hist = await this.history(st, { kind: 'merchant' });
      this.takeMovements(st, 'merchant_movements', rows, hist);
      if (!hist.complete) {
        st.sink.cannot(
          'merchant_movements',
          'incomplete',
          "WAWU's history is longer than the pages read.",
        );
      }
    } catch (e) {
      if (!(e instanceof WalletProviderError)) throw e;
      st.sink.cannot(
        'merchant_movements',
        e.kind === 'not_supported' ? 'not_checked' : 'incomplete',
        e.kind === 'not_supported'
          ? `Not checked on this provider: ${this.provider.label} cannot list WAWU's debits yet.`
          : "WAWU's debits could not be read.",
      );
    }
  }

  /** The held money figures, and the shortfall check against WAWU's account. */
  private async heldFigures(held: {
    openCount: number;
    openKobo: bigint;
    requiredKobo: bigint;
    merchantAvailableKobo: bigint | null;
  }): Promise<void> {
    const base: Prisma.WalletHoldWhereInput = {
      AND: [
        this.scope.holdWhere(),
        { provider: this.provider.name, status: 'held' },
      ],
    };
    const open = await this.prisma.walletHold.aggregate({
      where: base,
      _count: { _all: true },
      _sum: { amountKobo: true },
    });
    const handed = await this.prisma.walletHold.aggregate({
      where: { AND: [base, { sentAt: { not: null } }] },
      _sum: { transferKobo: true },
    });
    held.openCount = open._count._all;
    held.openKobo = open._sum.amountKobo ?? 0n;
    held.requiredKobo = requiredInAccount({
      heldKobo: held.openKobo,
      handedOverKobo: handed._sum.transferKobo ?? 0n,
    });
  }

  /** For each send that carries a WAWU fee, whether the provider's record shows it paid. */
  private async feeCharges(st: RunState): Promise<void> {
    const { sink, feeCandidates } = st;
    if (feeCandidates.length === 0) return;
    const cap = this.settings.feeLookups;
    const todo = feeCandidates.slice(0, cap);
    let unread = 0;
    for (const c of todo) {
      if (st.stopped) {
        unread += 1;
        continue;
      }
      await this.beat(st.run);
      try {
        const found = await this.ask(() =>
          this.provider.findTransactionById(c.providerId),
        );
        if (found.state !== 'found') {
          unread += 1;
          continue;
        }
        sink.compared('merchant_charges', 1);
        const verdict = compareMerchantCharge(
          c.expectedKobo,
          found.transaction,
        );
        if (verdict === 'ok') continue;
        sink.add({
          check: 'merchant_charges',
          severity: 'mismatch',
          kind:
            verdict === 'missing'
              ? 'merchant_charge_missing'
              : 'merchant_charge_differs',
          ref: c.rowId,
          detail:
            verdict === 'missing'
              ? "The ledger says WAWU's fee was charged on this send and the provider's record shows no charge paid to WAWU."
              : "The provider's record of this send shows a different charge paid to WAWU than the ledger's fee.",
          amountKobo: c.expectedKobo.toString(),
          ...(found.transaction.merchantChargeKobo == null
            ? {}
            : { otherKobo: found.transaction.merchantChargeKobo.toString() }),
        });
      } catch (e) {
        if (!(e instanceof WalletProviderError)) throw e;
        if (e.kind === 'not_supported') {
          sink.cannot(
            'merchant_charges',
            'not_checked',
            `Not checked on this provider: ${this.provider.label} cannot show WAWU's charge on a send yet.`,
          );
          return;
        }
        if (NO_POINT_GOING_ON.has(e.kind)) st.stopped = true;
        unread += 1;
      }
    }
    const left = feeCandidates.length - todo.length;
    if (unread > 0 || left > 0) {
      sink.cannot(
        'merchant_charges',
        'incomplete',
        `${unread + left} sends with a WAWU fee were not checked${left > 0 ? ` (at most ${cap} are looked up in one run)` : ''}.`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // The report
  // -------------------------------------------------------------------------

  private assemble(
    st: RunState,
    held: {
      openCount: number;
      openKobo: bigint;
      requiredKobo: bigint;
      merchantAvailableKobo: bigint | null;
    },
  ): MoneyCheckReport {
    const { sink } = st;
    // Short: WAWU's account holds less than the open holds need.
    if (
      held.merchantAvailableKobo !== null &&
      held.merchantAvailableKobo < held.requiredKobo
    ) {
      sink.add({
        check: 'held_money',
        severity: 'mismatch',
        kind: 'held_money_short',
        ref: 'wawu-account',
        detail: `WAWU's account holds ${(held.requiredKobo - held.merchantAvailableKobo).toString()} kobo less than the ${held.openCount} open holds need. Held money is not where it should be.`,
        amountKobo: held.requiredKobo.toString(),
        otherKobo: held.merchantAvailableKobo.toString(),
      });
    }
    if (held.merchantAvailableKobo !== null) {
      sink.compared('held_money', 1);
    }
    const checks = sink.summaries();
    const finishedAt = new Date();
    const report: MoneyCheckReport = {
      version: 1,
      provider: this.provider.name,
      night: st.run.night,
      windowFrom: st.windowFrom ? st.windowFrom.toISOString() : null,
      windowTo: st.windowTo.toISOString(),
      startedAt: st.run.startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      verdict: 'clean',
      wallets: st.wallets,
      checks,
      held: {
        openCount: held.openCount,
        openKobo: held.openKobo.toString(),
        requiredKobo: held.requiredKobo.toString(),
        merchantAvailableKobo:
          held.merchantAvailableKobo === null
            ? null
            : held.merchantAvailableKobo.toString(),
      },
      mismatches: sink.mismatches,
      look: sink.look,
      omitted: sink.omitted,
      notices: sink.notices,
    };
    report.verdict = verdictOf(report, sink.mismatchCount, sink.lookCount);
    return report;
  }

  // -------------------------------------------------------------------------
  // Telling someone
  // -------------------------------------------------------------------------

  /**
   * Hands a finished report to WAWU ID for each recipient that has not had it.
   * One process delivers a report at a time (the claim on `nextEmailAt`); a
   * recipient WAWU ID would not take is tried again with a growing rest.
   */
  async deliver(runId: string, now = new Date()): Promise<void> {
    const recipients = this.settings.recipients;
    if (recipients.length === 0) {
      if (!this.warnedNoRecipients) {
        this.warnedNoRecipients = true;
        this.logger.warn(
          'money check: no recipient is set (MONEY_CHECK_RECIPIENT_WAWU_IDS), so no report is emailed.',
        );
      }
      return;
    }
    const claimed = await this.prisma.moneyCheckRun.updateMany({
      where: {
        id: runId,
        status: 'finished',
        emailedAt: null,
        OR: [{ nextEmailAt: null }, { nextEmailAt: { lte: now } }],
      },
      data: { nextEmailAt: new Date(now.getTime() + 5 * MINUTE) },
    });
    if (claimed.count !== 1) return;
    const run = await this.prisma.moneyCheckRun.findUnique({
      where: { id: runId },
    });
    if (!run?.report) return;
    const report = run.report as unknown as MoneyCheckReport;
    const mail = mailOf(report, {
      mismatchCount: run.mismatchCount ?? 0,
      lookCount: run.lookCount ?? 0,
    });
    const sent: string[] = [];
    let failed = 0;
    for (const id of recipients.filter((r) => !run.emailedTo.includes(r))) {
      try {
        await this.mailer.send(id, mail);
        sent.push(id);
        await this.prisma.moneyCheckRun.update({
          where: { id: runId },
          data: { emailedTo: { push: id } },
        });
      } catch (e) {
        failed += 1;
        this.logger.warn(
          `money check ${run.night}: the report was not taken for one recipient (${logReason(e)})`,
        );
      }
    }
    const attempts = run.emailAttempts + 1;
    const rest = Math.min(5 * MINUTE * 2 ** Math.min(attempts, 7), 6 * HOUR);
    await this.prisma.moneyCheckRun.update({
      where: { id: runId },
      data: {
        emailAttempts: attempts,
        emailedAt: failed === 0 ? now : null,
        nextEmailAt: failed === 0 ? null : new Date(now.getTime() + rest),
      },
    });
  }

  /** Finished reports that have not reached everyone, from the last week. */
  async sendDue(now = new Date()): Promise<void> {
    if (this.settings.recipients.length === 0) return;
    const due = await this.prisma.moneyCheckRun.findMany({
      where: {
        provider: this.provider.name,
        status: 'finished',
        emailedAt: null,
        emailAttempts: { lt: 40 },
        finishedAt: { gt: new Date(now.getTime() - 7 * 24 * HOUR) },
        OR: [{ nextEmailAt: null }, { nextEmailAt: { lte: now } }],
      },
      orderBy: { finishedAt: 'asc' },
      select: { id: true },
      take: 10,
    });
    for (const { id } of due) await this.deliver(id, now);
  }

  /** Forgets runs older than the keeping period. */
  private async prune(now: Date): Promise<void> {
    await this.prisma.moneyCheckRun.deleteMany({
      where: {
        provider: this.provider.name,
        status: 'finished',
        finishedAt: { lt: new Date(now.getTime() - this.settings.keepMs) },
      },
    });
  }
}

/**
 * Why a night could not be made: a code and one fixed sentence, nothing else
 * (round 2, VF-8). It is stored on the run and read out in the emailed note,
 * so it never carries an exception's own text, which could hold a value from
 * a library, the database or the provider.
 */
export interface RunFailure {
  code: string;
  sentence: string;
}

/** The run's process was lost and nobody took the night up again. */
export const RUN_DIED: RunFailure = {
  code: 'run_died',
  sentence: 'The run stopped before it finished and was not made again.',
};

const INTERNAL_ERROR: RunFailure = {
  code: 'internal_error',
  sentence:
    'The check stopped on an error inside the Hub. The Hub log names it.',
};

/** What a thrown error is reported as. Provider failures keep their closed kind. */
export function failureOf(e: unknown): RunFailure {
  if (e instanceof WalletProviderError) {
    return {
      code: `provider_${e.kind}`,
      sentence:
        'The wallet provider failed while the check was reading from it.',
    };
  }
  return INTERNAL_ERROR;
}

/** How a failure is stored on the run: `code: sentence`. */
export function failureText(f: RunFailure): string {
  return `${f.code}: ${f.sentence}`;
}

const STORED_FAILURE = /^([a-z][a-z_]{2,39}): ([A-Za-z0-9 .,'()-]{1,200})$/;

/** A failure read back from the run row; anything that is not one of ours is a lost run. */
export function storedFailure(text: string | null): RunFailure {
  const m = text === null ? null : STORED_FAILURE.exec(text);
  return m ? { code: m[1], sentence: m[2] } : RUN_DIED;
}

/**
 * One finding as a single log line. A reference can come from the provider,
 * so it is cut to the characters of `plainRef` (no newline or control
 * character), or a reference could forge a log line (SWEEP-MONEY RF-5).
 */
export function findingLogLine(
  night: string,
  f: Pick<Finding, 'severity' | 'kind' | 'ref' | 'amountKobo'>,
): string {
  return (
    `money check ${night}: ${f.severity} ${f.kind} ${plainRef(f.ref)}` +
    (f.amountKobo === undefined ? '' : ` ${f.amountKobo} kobo`)
  );
}

/** What an error is called in the Hub's own log (never stored, never mailed). */
function logReason(e: unknown): string {
  if (e instanceof MoneyCheckMailRefused) return e.message;
  if (e instanceof WalletProviderError) return `provider ${e.kind}`;
  return e instanceof Error ? e.name : 'an unknown error';
}

/** The report of a night that could not be made. */
export function failureReport(
  provider: string,
  night: string,
  startedAt: Date,
  finishedAt: Date,
  failure: RunFailure | null = null,
): MoneyCheckReport {
  const note = failure
    ? `The run did not finish. ${failure.sentence} (${failure.code}).`
    : 'The run did not finish.';
  return {
    version: 1,
    provider,
    night,
    windowFrom: null,
    windowTo: finishedAt.toISOString(),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    verdict: 'incomplete',
    wallets: { total: 0, checked: 0, notChecked: {} },
    checks: CHECK_IDS.map((id: CheckId) => ({
      id,
      state: 'incomplete' as const,
      checked: 0,
      found: 0,
      note,
    })),
    held: {
      openCount: 0,
      openKobo: '0',
      requiredKobo: '0',
      merchantAvailableKobo: null,
    },
    mismatches: [],
    look: [],
    omitted: { mismatches: 0, look: 0 },
    notices: {},
  };
}

/**
 * The night's verdict. A mismatch is `differences`. A night in which nothing
 * could be compared with the provider is `not_checked`. A night in which
 * something could not be compared is `incomplete`, never clean. Otherwise a
 * night with something for a person is `needs_a_look`, and only a night with
 * every comparison made and nothing found is `clean`.
 */
export function verdictOf(
  report: Pick<MoneyCheckReport, 'checks' | 'wallets'>,
  mismatchCount: number,
  lookCount: number,
): Verdict {
  if (mismatchCount > 0) return 'differences';
  const provider = report.checks.filter((c) =>
    ['movements', 'merchant_movements', 'balances'].includes(c.id),
  );
  if (provider.length > 0 && provider.every((c) => c.state === 'not_checked')) {
    return 'not_checked';
  }
  const unchecked = Object.values(report.wallets.notChecked).reduce(
    (n, v) => n + (v ?? 0),
    0,
  );
  if (
    unchecked > 0 ||
    report.checks.some(
      (c) => c.state === 'incomplete' || c.state === 'not_checked',
    )
  ) {
    return 'incomplete';
  }
  return lookCount > 0 ? 'needs_a_look' : 'clean';
}
