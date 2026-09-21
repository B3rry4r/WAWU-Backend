import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Prisma } from '../../../generated/prisma/client';
import type { ReviewStatus } from '../../../generated/prisma/enums';
import type { Paginated } from '../../common/interceptors/response.interceptor';
import {
  FLUTTERWAVE_WALLET_GATEWAY,
  type FlutterwaveWalletGateway,
} from '../../wallet/flutterwave-wallet.gateway';
import { toGatesView } from '../creators/admin-creators.service';
import type {
  AdminFinanceOwedStreamView,
  AdminFinancePayoutView,
  AdminFinancePayoutsView,
  AdminFinanceWalletBalanceView,
  AdminFinanceWalletDetailView,
  AdminFinanceWalletEntryView,
  AdminFinanceWalletView,
} from './admin-finance-view.type';
import { resolvePeriod, toPeriodView } from './admin-finance.service';
import type { AdminFinancePayoutsQueryDto } from './dto/admin-finance-payouts-query.dto';
import { BALANCE_PAGE_CAP } from './dto/admin-finance-wallets-query.dto';
import type {
  AdminFinanceWalletDetailQueryDto,
  AdminFinanceWalletsQueryDto,
} from './dto/admin-finance-wallets-query.dto';

const OWED_NOTE =
  'Creator money WAWU has not confirmed into a wallet. These are sums of source rows and of our own instruction ledger, never a balance: Flutterwave custodies each wallet and their figure is the authoritative one.';

/** Kobo to whole naira, floored, so a reported figure never exceeds what was banked. */
function koboToNaira(kobo: number): number {
  return Math.floor(kobo / 100);
}

/** Postgres hands SUM() back as bigint, and Prisma hands bigint back as BigInt. */
function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (value === null || value === undefined) return 0;
  return Number(value);
}

/** Last four digits of an account number. The full number never leaves this backend on this surface. */
function last4(accountNumber: string | null): string | null {
  if (!accountNumber) return null;
  return accountNumber.slice(-4);
}

/**
 * PAYOUTS AND WALLETS, READ-ONLY.
 *
 * ── THE BALANCE RULE, WHICH IS THE WHOLE POINT OF THIS FILE ──────────────
 * A creator's wallet is a payout subaccount at Flutterwave MFB, opened in
 * their own name under Flutterwave's CBN banking licence. Flutterwave
 * custodies the money; WAWU only instructs. So Flutterwave's number is the
 * balance and nothing else is, and this service reports it by ASKING them,
 * through the same gateway `GET /wallet` asks through.
 *
 * Every other figure here is a sum of rows WAWU itself wrote, and every one
 * of them is named for what it is: `earnedInstructedNaira` is what WAWU
 * instructed and Flutterwave confirmed, `earningsPendingNaira` is what it
 * instructed and Flutterwave has not answered on, `withdrawnNaira` is what
 * left for an outside bank account. None of them is offered as a balance,
 * and when Flutterwave cannot be reached the balance is null with a reason
 * rather than one of these standing in for it.
 *
 * ── AND NOTHING HERE WRITES ──────────────────────────────────────────────
 * No adjust, no credit, no reverse, no manual payout. An admin write path
 * over an account WAWU does not custody is a fraud surface, and a figure that
 * looks wrong is a defect at its source.
 */
@Injectable()
export class AdminFinanceWalletsService {
  private readonly logger = new Logger(AdminFinanceWalletsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(FLUTTERWAVE_WALLET_GATEWAY)
    private readonly flw: FlutterwaveWalletGateway,
  ) {}

  // ── GET /admin/finance/payouts ────────────────────────────────────────────

  /**
   * What has left for creators' bank accounts, and what has not left yet.
   *
   * The withdrawal list is bounded by the period. The `owed` block is NOT:
   * money earned in March and still unpaid in September is owed in September,
   * so bounding it to a month would report it as settled.
   */
  async payouts(
    query: AdminFinancePayoutsQueryDto,
  ): Promise<AdminFinancePayoutsView> {
    const period = resolvePeriod(query.from, query.to, new Date());
    const where: Prisma.WalletLedgerEntryWhereInput = {
      kind: 'withdrawal',
      createdAt: { gte: period.from, lt: period.to },
      ...(query.status ? { status: query.status } : {}),
    };

    const [entries, total, byStatus] = await Promise.all([
      this.prisma.walletLedgerEntry.findMany({
        where,
        orderBy: { createdAt: query.sort === 'oldest' ? 'asc' : 'desc' },
        skip: (query.page - 1) * query.perPage,
        take: query.perPage,
      }),
      this.prisma.walletLedgerEntry.count({ where }),
      this.prisma.walletLedgerEntry.groupBy({
        by: ['status'],
        where,
        orderBy: { status: 'asc' },
        _sum: { amount: true },
      }),
    ]);

    const entryIds = entries.map((e) => e.id);
    const creatorIds = [...new Set(entries.map((e) => e.wawuUserId))];
    const [withdrawals, handles, owed] = await Promise.all([
      entryIds.length
        ? this.prisma.walletWithdrawal.findMany({
            where: { entryId: { in: entryIds } },
          })
        : Promise.resolve([]),
      this.handlesFor(creatorIds),
      this.owed(),
    ]);

    const detailByEntry = new Map(withdrawals.map((w) => [w.entryId, w]));
    const sumFor = (status: string) =>
      byStatus.find((g) => g.status === status)?._sum.amount ?? 0;

    const items: AdminFinancePayoutView[] = entries.map((entry) => {
      const detail = detailByEntry.get(entry.id) ?? null;
      return {
        id: entry.id,
        creator: {
          wawuId: entry.wawuUserId,
          handle: handles.get(entry.wawuUserId) ?? null,
        },
        amountNaira: entry.amount,
        status: entry.status,
        reference: entry.reference,
        transferId: entry.transferId,
        failureReason: entry.failureReason,
        bankCode: detail?.bankCode ?? null,
        accountName: detail?.accountName ?? null,
        accountNumberLast4: last4(detail?.accountNumber ?? null),
        createdAt: entry.createdAt.toISOString(),
        settledAt: entry.settledAt?.toISOString() ?? null,
      };
    });

    return {
      period: toPeriodView(period),
      currency: 'NGN',
      amountsIn: 'naira',
      withdrawals: {
        items,
        page: query.page,
        perPage: query.perPage,
        total,
        completedNaira: sumFor('completed'),
        pendingNaira: sumFor('pending'),
        failedNaira: sumFor('failed'),
      },
      owed,
    };
  }

  /**
   * Creator money that has not been confirmed into a wallet, in three kinds.
   *
   * The third kind is the one nobody could see before: a completed sale whose
   * creator share has no `WalletLedgerEntry` against it AT ALL. That is the
   * same "rows with no matching entry" question `WalletFundingService` asks
   * to decide what to pay next, asked here to decide what is outstanding, and
   * written the same way - raw SQL, because the ledger references its source
   * rows by (sourceType, sourceId) across several tables with no declared
   * relation, which Prisma cannot express as a join.
   *
   * Credits and event tickets carry `sweptAutomatically: false` because the
   * sweep covers purchases and answered DMs only. Their creator share is
   * computed by this platform and has no path into a wallet, which is a real
   * gap in the payout chain and is reported as one rather than rolled into a
   * single "owed" number that hides it.
   */
  private async owed(): Promise<AdminFinancePayoutsView['owed']> {
    const [
      earningStatuses,
      purchaseRows,
      dmRows,
      eventRows,
      creditEarnings,
      creditSpendCount,
    ] = await Promise.all([
      this.prisma.walletLedgerEntry.groupBy({
        by: ['status'],
        where: { kind: 'earning' },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.$queryRaw<
        Array<{ type: string; rows: bigint | number; owed: bigint | number }>
      >(Prisma.sql`
        SELECT p."type"::text AS "type",
               COUNT(*)::bigint AS "rows",
               COALESCE(SUM(FLOOR(p."amount" * (1 - p."commissionRate"))), 0)::bigint AS "owed"
          FROM "Purchase" p
         WHERE p."status" = 'completed'
           AND NOT EXISTS (
                 SELECT 1 FROM "WalletLedgerEntry" e
                  WHERE e."sourceType" = 'purchase' AND e."sourceId" = p."id"
               )
         GROUP BY p."type"
      `),
      this.prisma.$queryRaw<
        Array<{ rows: bigint | number; owed: bigint | number }>
      >(
        Prisma.sql`
          SELECT COUNT(*)::bigint AS "rows",
                 COALESCE(SUM(FLOOR(d."amount" * 0.85)), 0)::bigint AS "owed"
            FROM "DirectMessage" d
           WHERE d."status" = 'responded'
             AND NOT EXISTS (
                   SELECT 1 FROM "WalletLedgerEntry" e
                    WHERE e."sourceType" = 'direct_message' AND e."sourceId" = d."id"
                 )
        `,
      ),
      this.prisma.$queryRaw<
        Array<{ rows: bigint | number; owed: bigint | number }>
      >(
        Prisma.sql`
          SELECT COUNT(*)::bigint AS "rows",
                 COALESCE(SUM(FLOOR(o."amountNaira" * (1 - o."commissionRate"))), 0)::bigint AS "owed"
            FROM "EventOrder" o
           WHERE o."status" = 'paid'
             AND NOT EXISTS (
                   SELECT 1 FROM "WalletLedgerEntry" e
                    WHERE e."sourceType" = 'event_order' AND e."sourceId" = o."id"
                 )
        `,
      ),
      this.prisma.creditSpendEarning.aggregate({
        _sum: { hostShareKobo: true },
      }),
      this.prisma.creditSpendEarning.count(),
    ]);

    const statusRow = (status: string) =>
      earningStatuses.find((g) => g.status === status);

    const purchaseFor = (type: string) =>
      purchaseRows.find((r) => r.type === type);

    const streams: AdminFinanceOwedStreamView[] = [
      {
        stream: 'content',
        sourceRows: toNumber(purchaseFor('content')?.rows ?? 0),
        creatorShareNaira: toNumber(purchaseFor('content')?.owed ?? 0),
        sweptAutomatically: true,
        why: 'A completed content purchase with no wallet ledger entry against it. The funding sweep pays these on its next pass; a row that stays here has no wallet to pay into, or the sweep is switched off.',
      },
      {
        stream: 'tips',
        sourceRows: toNumber(purchaseFor('tip')?.rows ?? 0),
        creatorShareNaira: toNumber(purchaseFor('tip')?.owed ?? 0),
        sweptAutomatically: true,
        why: 'A completed tip with no wallet ledger entry against it. Same sweep, same reasons for sitting here.',
      },
      {
        stream: 'dm',
        sourceRows: toNumber(dmRows[0]?.rows ?? 0),
        creatorShareNaira: toNumber(dmRows[0]?.owed ?? 0),
        sweptAutomatically: true,
        why: 'A paid message the creator answered, with no wallet ledger entry against it. An unanswered message is refundable and is deliberately absent from this figure.',
      },
      {
        stream: 'credits',
        sourceRows: creditSpendCount,
        creatorShareNaira: koboToNaira(creditEarnings._sum.hostShareKobo ?? 0),
        sweptAutomatically: false,
        why: 'Every host share ever snapshotted on CreditSpendEarning. The funding sweep reads purchases and answered DMs only, so no credit spend has a path into a wallet and the whole lifetime figure is outstanding.',
      },
      {
        stream: 'events',
        sourceRows: toNumber(eventRows[0]?.rows ?? 0),
        creatorShareNaira: toNumber(eventRows[0]?.owed ?? 0),
        sweptAutomatically: false,
        why: 'Every paid ticket order, at the rate snapshotted on it. The funding sweep reads purchases and answered DMs only, so an organiser share has no path into a wallet either.',
      },
    ];

    return {
      note: OWED_NOTE,
      instructedAwaitingConfirmation: {
        count: statusRow('pending')?._count._all ?? 0,
        amountNaira: statusRow('pending')?._sum.amount ?? 0,
      },
      instructionsFailed: {
        count: statusRow('failed')?._count._all ?? 0,
        amountNaira: statusRow('failed')?._sum.amount ?? 0,
      },
      earnedNotInstructed: streams,
      earnedNotInstructedTotalNaira: streams.reduce(
        (sum, s) => sum + s.creatorShareNaira,
        0,
      ),
    };
  }

  // ── GET /admin/finance/wallets ────────────────────────────────────────────

  /**
   * One row per creator account, whether or not Flutterwave has opened a
   * subaccount for them.
   *
   * Listed off `UserProfile` rather than off `CreatorWallet`, because a
   * creator with NO wallet is exactly the row an operator is looking for when
   * earnings are piling up and nothing is reaching a bank account. Listing
   * the wallet table would hide them.
   */
  async wallets(
    query: AdminFinanceWalletsQueryDto,
  ): Promise<Paginated<AdminFinanceWalletView>> {
    const perPage = query.withBalances
      ? Math.min(query.perPage, BALANCE_PAGE_CAP)
      : query.perPage;

    const scope = await this.scopeIds(query);
    if (scope.in !== null && scope.in.length === 0) {
      return { items: [], currentPage: query.page, perPage, total: 0 };
    }

    const q = query.q?.trim();
    const where: Prisma.UserProfileWhereInput = {
      accountType: 'creator',
      ...(q
        ? {
            OR: [
              { handle: { contains: q, mode: 'insensitive' as const } },
              { wawuUserId: { startsWith: q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
      ...(scope.in !== null || scope.notIn.length > 0
        ? {
            wawuUserId: {
              ...(scope.in !== null ? { in: scope.in } : {}),
              ...(scope.notIn.length > 0 ? { notIn: scope.notIn } : {}),
            },
          }
        : {}),
    };

    const orderBy: Prisma.UserProfileOrderByWithRelationInput[] =
      query.sort === 'handle'
        ? [{ handle: 'asc' }, { createdAt: 'desc' }]
        : [{ createdAt: query.sort === 'oldest' ? 'asc' : 'desc' }];

    const [profiles, total] = await this.prisma.$transaction([
      this.prisma.userProfile.findMany({
        where,
        orderBy,
        skip: (query.page - 1) * perPage,
        take: perPage,
        select: { wawuUserId: true, handle: true },
      }),
      this.prisma.userProfile.count({ where }),
    ]);

    const items = await this.toWalletRows(
      profiles.map((p) => ({ wawuId: p.wawuUserId, handle: p.handle })),
      query.withBalances,
    );
    return { items, currentPage: query.page, perPage, total };
  }

  // ── GET /admin/finance/wallets/:wawuId ────────────────────────────────────

  /**
   * One creator's wallet, with its own ledger.
   *
   * Reads `CreatorWallet` directly rather than through `WalletService.getWallet`,
   * which OPENS a wallet when it finds none. Opening a bank account as a side
   * effect of an admin looking at a screen is not a read, so this path does
   * not take it: no subaccount means `payoutSubaccount: null` and a balance
   * of null with a reason.
   */
  async walletDetail(
    wawuUserId: string,
    query: AdminFinanceWalletDetailQueryDto,
  ): Promise<AdminFinanceWalletDetailView> {
    const [profile, state, wallet, history, historyTotal] = await Promise.all([
      this.prisma.userProfile.findUnique({
        where: { wawuUserId },
        select: { wawuUserId: true, handle: true },
      }),
      this.prisma.creatorState.findUnique({ where: { wawuUserId } }),
      this.prisma.creatorWallet.findUnique({ where: { wawuUserId } }),
      this.prisma.walletLedgerEntry.findMany({
        where: { wawuUserId },
        orderBy: { createdAt: 'desc' },
        take: query.historyLimit,
      }),
      this.prisma.walletLedgerEntry.count({ where: { wawuUserId } }),
    ]);

    if (!profile && !state && !wallet) {
      throw new NotFoundException(
        'No account with that WAWU ID is known to this backend.',
      );
    }

    const [row] = await this.toWalletRows(
      [{ wawuId: wawuUserId, handle: profile?.handle ?? null }],
      true,
    );

    const entries: AdminFinanceWalletEntryView[] = history.map((e) => ({
      id: e.id,
      kind: e.kind,
      amountNaira: e.amount,
      status: e.status,
      reference: e.reference,
      transferId: e.transferId,
      sourceType: e.sourceType,
      sourceId: e.sourceId,
      failureReason: e.failureReason,
      createdAt: e.createdAt.toISOString(),
      settledAt: e.settledAt?.toISOString() ?? null,
    }));

    return {
      ...row,
      currency: 'NGN',
      amountsIn: 'naira',
      history: entries,
      historyTotal,
    };
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /**
   * The ids the CreatorState and CreatorWallet filters allow.
   *
   * `UserProfile`, `CreatorState` and `CreatorWallet` all key on the same
   * WAWU ID and have no declared Prisma relation between them, so a filter
   * spanning two of them cannot be one query. Declaring a relation would be a
   * change to the protected schema, so the id sets are materialised and
   * intersected here - the same bound `AdminCreatorsService` already carries
   * and documents for the same reason.
   */
  private async scopeIds(
    query: AdminFinanceWalletsQueryDto,
  ): Promise<{ in: string[] | null; notIn: string[] }> {
    let allowed: string[] | null = null;
    const notIn: string[] = [];

    if (query.kycStatus !== undefined) {
      // `not_started` is not a stored value, so it cannot go into the WHERE as
      // itself - it becomes the pair of conditions the synthesis is defined
      // by: the column still at its `pending` default, and no KycSubmission
      // row ever written for the account. Same expansion `/admin/creators`
      // does, so the two admin screens cannot disagree about one creator.
      const notStarted = query.kycStatus === 'not_started';
      const submitterIds = notStarted
        ? (
            await this.prisma.kycSubmission.findMany({
              select: { wawuUserId: true },
              distinct: ['wawuUserId'],
            })
          ).map((row) => row.wawuUserId)
        : [];

      const rows = await this.prisma.creatorState.findMany({
        where: notStarted
          ? { kycStatus: 'pending', wawuUserId: { notIn: submitterIds } }
          : { kycStatus: query.kycStatus as ReviewStatus },
        select: { wawuUserId: true },
      });
      allowed = rows.map((r) => r.wawuUserId);
    }

    if (query.hasSubaccount !== undefined) {
      const rows = await this.prisma.creatorWallet.findMany({
        select: { wawuUserId: true },
      });
      const walletIds = rows.map((r) => r.wawuUserId);
      if (query.hasSubaccount) {
        const walletSet = new Set(walletIds);
        allowed =
          allowed === null
            ? walletIds
            : allowed.filter((id) => walletSet.has(id));
      } else {
        notIn.push(...walletIds);
      }
    }

    return { in: allowed, notIn };
  }

  /** Turns a page of creator ids into wallet rows in batched reads rather than per-row lookups. */
  private async toWalletRows(
    people: Array<{ wawuId: string; handle: string | null }>,
    withBalances: boolean,
  ): Promise<AdminFinanceWalletView[]> {
    const ids = people.map((p) => p.wawuId);
    if (ids.length === 0) return [];

    const [states, kycRows, wallets, ledger] = await Promise.all([
      this.prisma.creatorState.findMany({ where: { wawuUserId: { in: ids } } }),
      this.prisma.kycSubmission.findMany({
        where: { wawuUserId: { in: ids } },
        orderBy: { submittedAt: 'desc' },
        select: {
          wawuUserId: true,
          status: true,
          submittedAt: true,
          reviewedAt: true,
          rejectionReason: true,
        },
      }),
      this.prisma.creatorWallet.findMany({
        where: { wawuUserId: { in: ids } },
      }),
      this.prisma.walletLedgerEntry.groupBy({
        by: ['wawuUserId', 'kind', 'status'],
        where: { wawuUserId: { in: ids } },
        _sum: { amount: true },
      }),
    ]);

    const stateById = new Map(states.map((s) => [s.wawuUserId, s]));
    const walletById = new Map(wallets.map((w) => [w.wawuUserId, w]));
    // findMany is ordered newest-first, so the first row seen per user IS the
    // latest submission.
    const latestKycById = new Map<string, (typeof kycRows)[number]>();
    for (const row of kycRows) {
      if (!latestKycById.has(row.wawuUserId)) {
        latestKycById.set(row.wawuUserId, row);
      }
    }

    const sum = (wawuId: string, kind: string, status: string) =>
      ledger.find(
        (g) =>
          g.wawuUserId === wawuId && g.kind === kind && g.status === status,
      )?._sum.amount ?? 0;

    const balances = withBalances
      ? await this.balancesFor(
          people
            .map((p) => walletById.get(p.wawuId))
            .filter((w): w is NonNullable<typeof w> => !!w),
        )
      : new Map<string, AdminFinanceWalletBalanceView>();

    return people.map((person) => {
      const wallet = walletById.get(person.wawuId) ?? null;
      const gates = toGatesView(
        stateById.get(person.wawuId) ?? null,
        latestKycById.get(person.wawuId) ?? null,
      );
      return {
        creator: { wawuId: person.wawuId, handle: person.handle },
        kycStatus: gates.kycStatus,
        // The same gate WalletService.withdraw() enforces, read from the same
        // column, so this screen and what the creator can actually do cannot
        // disagree.
        withdrawalsEnabled: gates.kycStatus === 'approved',
        payoutSubaccount: wallet
          ? {
              accountReference: wallet.accountReference,
              bankName: wallet.bankName,
              accountNumberLast4: last4(wallet.nuban),
              status: wallet.status,
              openedAt: wallet.createdAt.toISOString(),
            }
          : null,
        balance:
          balances.get(person.wawuId) ??
          unavailableBalance(
            wallet
              ? withBalances
                ? 'Flutterwave could not be reached for this wallet.'
                : 'Balances are fetched from Flutterwave one wallet at a time. Ask for them with ?withBalances=true.'
              : 'Flutterwave has not opened a payout subaccount for this account, so there is no balance to read.',
          ),
        lifetime: {
          // Mirrors WalletService.ledgerTotals() exactly: a reversal is an
          // earning taken back, so it comes off what was paid in.
          earnedInstructedNaira:
            sum(person.wawuId, 'earning', 'completed') -
            sum(person.wawuId, 'reversal', 'completed'),
          earningsPendingNaira: sum(person.wawuId, 'earning', 'pending'),
          withdrawnNaira: sum(person.wawuId, 'withdrawal', 'completed'),
        },
      };
    });
  }

  /**
   * Flutterwave's balance for each wallet on the page, asked for in parallel.
   *
   * One failure does not fail the page: an unreachable Flutterwave leaves
   * that row's balance null with a reason, and the rest of the page still
   * renders. The alternative - substituting a figure summed from our own
   * ledger - is the one substitution this surface must never make.
   */
  private async balancesFor(
    wallets: Array<{ wawuUserId: string; accountReference: string }>,
  ): Promise<Map<string, AdminFinanceWalletBalanceView>> {
    const results = await Promise.allSettled(
      wallets.map((w) => this.flw.balance(w.accountReference)),
    );
    const map = new Map<string, AdminFinanceWalletBalanceView>();
    results.forEach((result, index) => {
      const wallet = wallets[index];
      if (!wallet) return;
      if (result.status === 'fulfilled') {
        map.set(wallet.wawuUserId, {
          ngn: result.value.availableNgn,
          source: 'flutterwave',
          unavailableReason: null,
        });
        return;
      }
      this.logger.warn(
        `Could not read the Flutterwave balance for ${wallet.accountReference}: ${(result.reason as Error).message}`,
      );
      map.set(
        wallet.wawuUserId,
        unavailableBalance('Flutterwave could not be reached for this wallet.'),
      );
    });
    return map;
  }

  private async handlesFor(ids: string[]): Promise<Map<string, string | null>> {
    if (ids.length === 0) return new Map();
    const profiles = await this.prisma.userProfile.findMany({
      where: { wawuUserId: { in: ids } },
      select: { wawuUserId: true, handle: true },
    });
    return new Map(profiles.map((p) => [p.wawuUserId, p.handle]));
  }
}

function unavailableBalance(reason: string): AdminFinanceWalletBalanceView {
  return { ngn: null, source: 'flutterwave', unavailableReason: reason };
}
