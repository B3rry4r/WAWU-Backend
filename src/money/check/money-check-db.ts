import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { rowsOf } from '../../wallet-provider/provider-rows';
import type { WalletProviderName } from '../../wallet-provider/wallet-provider.interface';
import { HELD_PAYMENT_KINDS } from '../dto/money-enums';
import { LEDGER_ABSENT_FAILURE } from '../ledger/ledger.service';
import type { MoneyCheckScope } from './money-check-scope';
import type { FindingSink } from './money-check-sink';
import { type CheckId, type Finding, REPORT_KEEP } from './money-check-types';

/**
 * The checks of the nightly check that read WAWU's own tables only (task
 * MONEY-16): the ledger's stops, the payments and holds a person has to
 * look at, and whether each completed payment and each settled hold left
 * the ledger rows it should. None of them calls the provider, and none of
 * them changes a row.
 */
export interface DbCheckContext {
  prisma: PrismaService;
  provider: WalletProviderName;
  scope: MoneyCheckScope;
  now: Date;
  windowFrom: Date | null;
  /** How long a pending row may wait before a person looks (the ledger's confirm window). */
  confirmWindowMs: number;
  /** How long a payment or hold may wait on the provider (PAYMENT_REVIEW_AFTER_HOURS). */
  reviewAfterMs: number;
  /** Movements younger than this are left to tomorrow. */
  settleMs: number;
  sink: FindingSink;
}

const HOUR = 3_600_000;
const PAGE = 500;

type PaymentRowsPage = Array<{
  id: string;
  customerReference: string;
  payerWawuUserId: string | null;
  priceKobo: bigint;
}>;
type HoldRowsPage = Array<{
  id: string;
  customerReference: string | null;
  transferKobo: bigint | null;
  status: string;
}>;

/** The ledger rows of the provider this server runs, narrowed by the scope. */
function ledgerRows(
  ctx: DbCheckContext,
  where: Prisma.FintavaLedgerEntryWhereInput,
): Prisma.FintavaLedgerEntryWhereInput {
  return { AND: [rowsOf(ctx.provider), ctx.scope.ledgerWhere(), where] };
}

/**
 * Adds a query's rows as findings, up to what a report keeps, and counts
 * the rest. `total` is only asked when the page was full.
 */
async function addRows<T>(
  ctx: DbCheckContext,
  check: CheckId,
  severity: Finding['severity'],
  rows: readonly T[],
  total: () => Promise<number>,
  toFindings: (row: T) => Finding[],
): Promise<void> {
  for (const row of rows) ctx.sink.addAll(toFindings(row));
  if (rows.length >= REPORT_KEEP) {
    ctx.sink.skipped(check, severity, (await total()) - rows.length);
  }
}

// ---------------------------------------------------------------------------
// ledger_rows
// ---------------------------------------------------------------------------

/**
 * Three stops the ledger leaves for a person, and the rows a completed
 * payment should have left:
 * - a row the ledger itself marked as disagreeing with the provider
 *   (`discrepancy`): a mismatch until a person settles it;
 * - a row still `pending` after the ledger's confirm window;
 * - a failed bank send nobody has seen come back (BACKEND_GAPS G-39), past
 *   that window.
 */
export async function checkLedgerRows(ctx: DbCheckContext): Promise<void> {
  const { prisma, now, sink } = ctx;
  const old = new Date(now.getTime() - ctx.confirmWindowMs);

  const stopped = ledgerRows(ctx, { discrepancy: { not: null } });
  sink.compared(
    'ledger_rows',
    await prisma.fintavaLedgerEntry.count({ where: ledgerRows(ctx, {}) }),
  );
  await addRows(
    ctx,
    'ledger_rows',
    'mismatch',
    await prisma.fintavaLedgerEntry.findMany({
      where: stopped,
      select: { id: true, amountKobo: true, status: true },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      take: REPORT_KEEP,
    }),
    () => prisma.fintavaLedgerEntry.count({ where: stopped }),
    (r) => [
      {
        check: 'ledger_rows',
        severity: 'mismatch',
        kind: 'ledger_discrepancy',
        ref: r.id,
        detail: `The ledger marked this ${r.status} row as disagreeing with the provider and nobody has settled it.`,
        amountKobo: r.amountKobo.toString(),
      },
    ],
  );

  const stuck = ledgerRows(ctx, {
    status: 'pending',
    createdAt: { lt: old },
    discrepancy: null,
  });
  await addRows(
    ctx,
    'ledger_rows',
    'look',
    await prisma.fintavaLedgerEntry.findMany({
      where: stuck,
      select: { id: true, amountKobo: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: REPORT_KEEP,
    }),
    () => prisma.fintavaLedgerEntry.count({ where: stuck }),
    (r) => [
      {
        check: 'ledger_rows',
        severity: 'look',
        kind: 'ledger_pending_old',
        ref: r.id,
        detail: `This row has been pending for more than ${Math.round(ctx.confirmWindowMs / HOUR)} hours.`,
        amountKobo: r.amountKobo.toString(),
      },
    ],
  );

  const unreversed = ledgerRows(ctx, {
    status: 'failed',
    direction: 'out',
    reversedAt: null,
    counterpartyKind: 'bank_account',
    occurredAt: { lt: old },
    discrepancy: null,
    OR: [
      { failureReason: null },
      { failureReason: { not: LEDGER_ABSENT_FAILURE } },
    ],
  });
  await addRows(
    ctx,
    'ledger_rows',
    'look',
    await prisma.fintavaLedgerEntry.findMany({
      where: unreversed,
      select: { id: true, totalKobo: true },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      take: REPORT_KEEP,
    }),
    () => prisma.fintavaLedgerEntry.count({ where: unreversed }),
    (r) => [
      {
        check: 'ledger_rows',
        severity: 'look',
        kind: 'failed_send_no_reversal',
        ref: r.id,
        detail:
          'A send to a bank failed and no reversal of its debit has been seen. The money may not have come back.',
        amountKobo: r.totalKobo.toString(),
      },
    ],
  );

  await checkPaymentRows(ctx);
}

/**
 * Each payment completed in the window left a `completed` row on WAWU's
 * account and, while its payer's account exists, on the payer's wallet; none
 * of them marked as disagreeing. A missing, pending or marked row is a
 * mismatch: money moved and the ledger does not say so.
 */
async function checkPaymentRows(ctx: DbCheckContext): Promise<void> {
  const { prisma, now, sink } = ctx;
  const upTo = new Date(now.getTime() - ctx.settleMs);
  const where: Prisma.WalletPaymentWhereInput = {
    AND: [
      ctx.scope.paymentWhere(),
      {
        provider: ctx.provider,
        status: 'completed',
        completedAt: {
          ...(ctx.windowFrom ? { gte: ctx.windowFrom } : {}),
          lt: upTo,
        },
      },
    ],
  };
  let after: string | null = null;
  for (;;) {
    const page: PaymentRowsPage = await prisma.walletPayment.findMany({
      where: after ? { AND: [where, { id: { gt: after } }] } : where,
      select: {
        id: true,
        customerReference: true,
        payerWawuUserId: true,
        priceKobo: true,
      },
      orderBy: { id: 'asc' },
      take: PAGE,
    });
    if (page.length === 0) break;
    const rows = await prisma.fintavaLedgerEntry.findMany({
      where: ledgerRows(ctx, {
        customerReference: { in: page.map((p) => p.customerReference) },
      }),
      select: {
        customerReference: true,
        walletKind: true,
        direction: true,
        status: true,
        discrepancy: true,
      },
    });
    for (const p of page) {
      sink.compared('ledger_rows', 1);
      const mine = rows.filter(
        (r) => r.customerReference === p.customerReference,
      );
      const problems: string[] = [];
      const need = (
        label: string,
        kind: 'merchant' | 'user',
        dir: 'in' | 'out',
      ) => {
        const row = mine.find(
          (r) => r.walletKind === kind && r.direction === dir,
        );
        if (!row) problems.push(`no row ${label}`);
        else if (row.status !== 'completed')
          problems.push(`the row ${label} is ${row.status}`);
        else if (row.discrepancy !== null)
          problems.push(`the row ${label} is marked as disagreeing`);
      };
      need("on WAWU's account", 'merchant', 'in');
      if (p.payerWawuUserId !== null)
        need("on the payer's wallet", 'user', 'out');
      if (problems.length > 0) {
        sink.add({
          check: 'ledger_rows',
          severity: 'mismatch',
          kind: 'payment_rows',
          ref: p.id,
          detail: `This payment completed and the ledger does not agree: ${problems.join('; ')}.`,
          amountKobo: p.priceKobo.toString(),
        });
      }
    }
    after = page[page.length - 1].id;
    if (page.length < PAGE) break;
  }
}

// ---------------------------------------------------------------------------
// payments
// ---------------------------------------------------------------------------

/**
 * Payments a person has to look at (MONEY-17, MONEY-19, BACKEND_GAPS G-480):
 * silence from the provider never ends a payment, so one the provider has
 * not answered for goes to review and stays pending until a person decides.
 * Also a payment whose charge was not believed (N2), one the provider
 * debited above the quote, and one paid twice for one item (D1.4).
 */
export async function checkPayments(ctx: DbCheckContext): Promise<void> {
  const { prisma, now, sink } = ctx;
  const stale = new Date(now.getTime() - ctx.reviewAfterMs - 6 * HOUR);
  const where: Prisma.WalletPaymentWhereInput = {
    AND: [
      ctx.scope.paymentWhere(),
      { provider: ctx.provider },
      {
        OR: [
          { status: 'pending', reviewSince: { not: null } },
          { chargeReviewSince: { not: null } },
          { debitReviewSince: { not: null } },
          { discrepancy: { startsWith: 'paid twice' } },
          { status: 'pending', reviewSince: null, createdAt: { lt: stale } },
        ],
      },
    ],
  };
  const open = await prisma.walletPayment.count({
    where: {
      AND: [
        ctx.scope.paymentWhere(),
        { provider: ctx.provider, status: 'pending' },
      ],
    },
  });
  sink.compared('payments', open);
  await addRows(
    ctx,
    'payments',
    'look',
    await prisma.walletPayment.findMany({
      where,
      select: {
        id: true,
        status: true,
        priceKobo: true,
        totalKobo: true,
        reviewSince: true,
        chargeReviewSince: true,
        debitReviewSince: true,
        discrepancy: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: REPORT_KEEP,
    }),
    () => prisma.walletPayment.count({ where }),
    (p) => {
      const out: Finding[] = [];
      const price = p.priceKobo.toString();
      const add = (kind: Finding['kind'], detail: string): void => {
        out.push({
          check: 'payments',
          severity: 'look',
          kind,
          ref: p.id,
          detail,
          amountKobo: price,
        });
      };
      if (p.status === 'pending' && p.reviewSince !== null) {
        add(
          'payment_in_review',
          'The provider has not answered for this payment and it is in review. It stays pending until a person decides; the item stays blocked.',
        );
      } else if (p.status === 'pending' && p.createdAt < stale) {
        add(
          'payment_pending_old',
          'This payment has been pending past the review bound and is not in review.',
        );
      }
      if (p.chargeReviewSince !== null) {
        add(
          'payment_charge_review',
          "The provider's charge on this payment was not believed. It is held for a person.",
        );
      }
      if (p.debitReviewSince !== null) {
        add(
          'payment_debit_above_quote',
          'The provider debited this payment above the quoted total.',
        );
      }
      if (p.discrepancy?.startsWith('paid twice')) {
        add(
          'payment_paid_twice',
          'This item was paid for twice while the first payment was open. One of the two may be owed back.',
        );
      }
      return out;
    },
  );

  // Payments that completed at another total than the quote and were not
  // flagged: worth knowing (the quote may be wrong), not worth a look.
  const differ = await prisma.walletPayment.count({
    where: {
      AND: [
        ctx.scope.paymentWhere(),
        {
          provider: ctx.provider,
          status: 'completed',
          discrepancy: { not: null },
          chargeReviewSince: null,
          debitReviewSince: null,
          NOT: { discrepancy: { startsWith: 'paid twice' } },
          ...(ctx.windowFrom ? { completedAt: { gte: ctx.windowFrom } } : {}),
        },
      ],
    },
  });
  sink.notice('payments_differ_from_quote', differ);
}

// ---------------------------------------------------------------------------
// holds
// ---------------------------------------------------------------------------

/** Waits that mean a person is missing, not that the provider is slow. */
const PERSON_WAITS = ['payee_wallet', 'payer_wallet'];

/**
 * Holds a person has to look at (MONEY-18, R-19, R-11):
 * - in review (`reviewSince`);
 * - a move handed to the provider and not confirmed past the review bound;
 * - a move that has waited past the review bound for a reason other than a
 *   person's wallet (WAWU's account short, the provider out of reach, the
 *   provider refusing, a frozen wallet);
 * - money owed to a payee whose account was deleted (BACKEND_GAPS G-461):
 *   nobody is left to pay and nothing in WAWU says what to do with it.
 * A payee who has not opened a wallet yet is not a problem (R-11): their
 * earnings wait for them. Those are counted as a notice.
 */
export async function checkHolds(ctx: DbCheckContext): Promise<void> {
  const { prisma, now, sink } = ctx;
  const bound = new Date(now.getTime() - ctx.reviewAfterMs);
  const base: Prisma.WalletHoldWhereInput = {
    AND: [ctx.scope.holdWhere(), { provider: ctx.provider, status: 'held' }],
  };
  sink.compared('holds', await prisma.walletHold.count({ where: base }));

  const select = {
    id: true,
    amountKobo: true,
    payeeShareKobo: true,
    reviewSince: true,
    sentAt: true,
    actionAt: true,
    action: true,
    waiting: true,
    payeeWawuUserId: true,
  } satisfies Prisma.WalletHoldSelect;

  const problem: Prisma.WalletHoldWhereInput = {
    AND: [
      base,
      {
        OR: [
          { reviewSince: { not: null } },
          { action: { not: null }, sentAt: { lt: bound } },
          {
            action: { not: null },
            sentAt: null,
            actionAt: { lt: bound },
            OR: [{ waiting: null }, { waiting: { notIn: PERSON_WAITS } }],
          },
        ],
      },
    ],
  };
  await addRows(
    ctx,
    'holds',
    'look',
    await prisma.walletHold.findMany({
      where: problem,
      select,
      orderBy: [{ actionAt: 'asc' }, { id: 'asc' }],
      take: REPORT_KEEP,
    }),
    () => prisma.walletHold.count({ where: problem }),
    (h) => {
      const amountKobo = h.amountKobo.toString();
      if (h.reviewSince !== null) {
        return [
          {
            check: 'holds',
            severity: 'look',
            kind: 'hold_in_review',
            ref: h.id,
            detail:
              'This hold is in review: a person has to decide how its money moves.',
            amountKobo,
          },
        ];
      }
      if (h.sentAt !== null) {
        return [
          {
            check: 'holds',
            severity: 'look',
            kind: 'hold_move_stuck',
            ref: h.id,
            detail: `The ${h.action ?? 'move'} of this hold was handed to the provider more than ${Math.round(ctx.reviewAfterMs / HOUR)} hours ago and is not confirmed.`,
            amountKobo,
          },
        ];
      }
      return [
        {
          check: 'holds',
          severity: 'look',
          kind: 'hold_waiting_past_limit',
          ref: h.id,
          detail: `The ${h.action ?? 'move'} of this hold has waited more than ${Math.round(ctx.reviewAfterMs / HOUR)} hours (${h.waiting ?? 'no reason given'}).`,
          amountKobo,
        },
      ];
    },
  );

  // A payee with no wallet yet waits (R-11); one with no account is owed money
  // nobody can be paid.
  const withPayee = await prisma.walletHold.findMany({
    where: { AND: [base, { payeeWawuUserId: { not: null } }] },
    select: {
      id: true,
      payeeShareKobo: true,
      payeeWawuUserId: true,
      waiting: true,
    },
    orderBy: { id: 'asc' },
  });
  const gone = new Set<string>();
  const ids = [...new Set(withPayee.map((h) => h.payeeWawuUserId!))];
  for (let i = 0; i < ids.length; i += PAGE) {
    const chunk = ids.slice(i, i + PAGE);
    const alive = await prisma.userProfile.findMany({
      where: { wawuUserId: { in: chunk } },
      select: { wawuUserId: true },
    });
    const have = new Set(alive.map((a) => a.wawuUserId));
    for (const id of chunk) if (!have.has(id)) gone.add(id);
  }
  let waitingForWallet = 0;
  let waitingKobo = 0n;
  for (const h of withPayee) {
    if (gone.has(h.payeeWawuUserId!)) {
      sink.add({
        check: 'holds',
        severity: 'look',
        kind: 'hold_payee_deleted',
        ref: h.id,
        detail:
          "The person this hold is owed to has deleted their account. Nobody can be paid and the money stays in WAWU's account.",
        amountKobo: h.payeeShareKobo.toString(),
      });
    } else if (h.waiting === 'payee_wallet') {
      waitingForWallet += 1;
      waitingKobo += h.payeeShareKobo;
    }
  }
  sink.notice('holds_waiting_for_payee_wallet', waitingForWallet, waitingKobo);
}

// ---------------------------------------------------------------------------
// held_money (the parts that read WAWU's tables only)
// ---------------------------------------------------------------------------

/**
 * Two things that must be true of every hold, whatever the provider says:
 * - a completed payment of a held kind has its hold (a payment is
 *   `completed` exactly when its price is held, MONEY-18): a hold that is
 *   not in the ledger is a mismatch;
 * - a settled hold's move out of WAWU's account left its `completed`
 *   merchant-side row, under the hold's reference, not marked as disagreeing
 *   (BACKEND_GAPS G-447).
 */
export async function checkHeldRecords(ctx: DbCheckContext): Promise<void> {
  const { prisma, now, sink } = ctx;
  const upTo = new Date(now.getTime() - ctx.settleMs);

  const missing: Prisma.WalletPaymentWhereInput = {
    AND: [
      ctx.scope.paymentWhere(),
      {
        provider: ctx.provider,
        status: 'completed',
        kind: { in: [...HELD_PAYMENT_KINDS] },
        hold: { is: null },
        completedAt: { lt: upTo },
      },
    ],
  };
  sink.compared(
    'held_money',
    await prisma.walletPayment.count({
      where: {
        AND: [
          ctx.scope.paymentWhere(),
          {
            provider: ctx.provider,
            status: 'completed',
            kind: { in: [...HELD_PAYMENT_KINDS] },
          },
        ],
      },
    }),
  );
  await addRows(
    ctx,
    'held_money',
    'mismatch',
    await prisma.walletPayment.findMany({
      where: missing,
      select: { id: true, priceKobo: true },
      orderBy: [{ completedAt: 'asc' }, { id: 'asc' }],
      take: REPORT_KEEP,
    }),
    () => prisma.walletPayment.count({ where: missing }),
    (p) => [
      {
        check: 'held_money',
        severity: 'mismatch',
        kind: 'hold_missing',
        ref: p.id,
        detail:
          "This payment of a held kind completed and has no hold. The money sits in WAWU's account with nothing recorded to release or return it.",
        amountKobo: p.priceKobo.toString(),
      },
    ],
  );

  const settled: Prisma.WalletHoldWhereInput = {
    AND: [
      ctx.scope.holdWhere(),
      {
        provider: ctx.provider,
        status: { in: ['released', 'refunded'] },
        customerReference: { not: null },
        transferKobo: { gt: 0 },
        settledAt: {
          ...(ctx.windowFrom ? { gte: ctx.windowFrom } : {}),
          lt: upTo,
        },
      },
    ],
  };
  let after: string | null = null;
  for (;;) {
    const page: HoldRowsPage = await prisma.walletHold.findMany({
      where: after ? { AND: [settled, { id: { gt: after } }] } : settled,
      select: {
        id: true,
        customerReference: true,
        transferKobo: true,
        status: true,
      },
      orderBy: { id: 'asc' },
      take: PAGE,
    });
    if (page.length === 0) break;
    const rows = await prisma.fintavaLedgerEntry.findMany({
      where: ledgerRows(ctx, {
        walletKind: 'merchant',
        direction: 'out',
        customerReference: { in: page.map((h) => h.customerReference!) },
      }),
      select: { customerReference: true, status: true, discrepancy: true },
    });
    const byRef = new Map(rows.map((r) => [r.customerReference, r]));
    for (const h of page) {
      sink.compared('held_money', 1);
      const row = byRef.get(h.customerReference);
      let why: string | null = null;
      if (!row) why = "WAWU's account has no ledger row for it";
      else if (row.status !== 'completed')
        why = `its ledger row is ${row.status}`;
      else if (row.discrepancy !== null)
        why = 'its ledger row is marked as disagreeing';
      if (why) {
        sink.add({
          check: 'held_money',
          severity: 'mismatch',
          kind: 'hold_move_row',
          ref: h.id,
          detail: `This hold was ${h.status} and ${why}.`,
          amountKobo: h.transferKobo!.toString(),
        });
      }
    }
    after = page[page.length - 1].id;
    if (page.length < PAGE) break;
  }
}
