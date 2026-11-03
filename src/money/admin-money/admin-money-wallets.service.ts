import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { rowsOf } from '../../wallet-provider/provider-rows';
import {
  safeKoboNumber,
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import {
  ADMIN_MONEY_BALANCE_PAGE_CAP,
  type AdminMoneyBalanceView,
  type AdminMoneyHeldByKindView,
  type AdminMoneyHeldView,
  type AdminMoneyLedgerRowView,
  type AdminMoneyMerchantView,
  type AdminMoneyPageQueryDto,
  type AdminMoneyWalletDetailView,
  type AdminMoneyWalletPage,
  type AdminMoneyWalletsQueryDto,
  type AdminMoneyWalletView,
} from './admin-money.dto';

const DEFAULT_LIMIT = 20;
/** How many provider balance reads run at once on one page. */
const BALANCE_PARALLEL = 5;

export const BALANCE_NO_ANSWER =
  'The wallet provider did not answer for this wallet. Try again in a moment.';
export const BALANCE_TOO_LARGE =
  'The provider gave a figure too large to show exactly.';
export const RECORDS_NOTE =
  'These rows are our records of movements. They are not a balance. The balance is the wallet provider’s own answer.';
export const HELD_NOTE =
  'The holds below are our records of money waiting in WAWU’s account. They are not a balance. The balance above is the provider’s own answer.';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `<ms>:<id>` in base64url: the time a list is ordered by and the row's id. */
export function encodeAt(at: Date, id: string): string {
  return Buffer.from(`${at.getTime()}:${id}`).toString('base64url');
}

export function decodeAt(
  cursor: string | undefined,
): { at: Date; id: string } | null {
  if (!cursor) return null;
  const [ms, id] = Buffer.from(cursor, 'base64url').toString().split(':');
  const t = Number(ms);
  if (!Number.isSafeInteger(t) || !id || !UUID.test(id)) {
    throw new BadRequestException('cursor is not one this list gave.');
  }
  return { at: new Date(t), id };
}

function last4(accountNumber: string): string {
  return accountNumber.slice(-4);
}

type WalletRow = Prisma.FintavaWalletGetPayload<object>;

/**
 * What the dashboard sees of the app's money (DASH-B-HUB): the wallets of the
 * provider this server runs, one wallet with its recent records, and WAWU's
 * merchant wallet. Reads only.
 *
 * The balance rule (backend CLAUDE.md, "Money"): a balance shown is the
 * provider's own answer, asked for through the seam (`WALLET_PROVIDER`),
 * never a sum of our rows. A provider that does not answer gives a reason
 * and no figure. Only rows of the provider the server runs are ever listed
 * or asked about.
 */
@Injectable()
export class AdminMoneyWalletsService {
  private readonly logger = new Logger(AdminMoneyWalletsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(WALLET_PROVIDER) private readonly provider: WalletProvider,
  ) {}

  /** The provider's answer for one wallet: a balance, or the reason there is none. */
  private async askBalance(
    walletId: string,
  ): Promise<{ balance?: AdminMoneyBalanceView; balanceUnavailable?: string }> {
    try {
      const b = await this.provider.getBalance({ walletId });
      return {
        balance: {
          availableKobo: safeKoboNumber(b.availableKobo),
          bookedKobo: safeKoboNumber(b.bookedKobo),
          source: 'provider',
          asOf: new Date().toISOString(),
        },
      };
    } catch (err) {
      if (err instanceof RangeError)
        return { balanceUnavailable: BALANCE_TOO_LARGE };
      this.logger.warn(
        `admin wallet balance: the provider did not answer (${err instanceof Error ? err.name : 'error'})`,
      );
      return { balanceUnavailable: BALANCE_NO_ANSWER };
    }
  }

  private async handlesOf(ids: string[]): Promise<Map<string, string | null>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.userProfile.findMany({
      where: { wawuUserId: { in: ids } },
      select: { wawuUserId: true, handle: true },
    });
    return new Map(rows.map((r) => [r.wawuUserId, r.handle]));
  }

  private toWallet(
    row: WalletRow,
    handle: string | null,
  ): AdminMoneyWalletView {
    return {
      wawuId: row.wawuUserId,
      handle,
      displayName: row.accountName,
      provider: this.provider.name,
      openedAt: row.createdAt.toISOString(),
      status: 'open',
      accountLast4: last4(row.accountNumber),
    };
  }

  async list(query: AdminMoneyWalletsQueryDto): Promise<AdminMoneyWalletPage> {
    const withBalance = query.withBalance === true;
    const cap = withBalance ? ADMIN_MONEY_BALANCE_PAGE_CAP : 50;
    const limit = Math.min(query.limit ?? DEFAULT_LIMIT, cap);
    const cursor = decodeWalletCursor(query.cursor);

    const and: Prisma.FintavaWalletWhereInput[] = [rowsOf(this.provider.name)];
    const q = query.q?.trim().replace(/^@/, '');
    if (q) {
      const byHandle = await this.prisma.userProfile.findMany({
        where: { handle: { contains: q, mode: 'insensitive' } },
        select: { wawuUserId: true },
        take: 200,
      });
      const or: Prisma.FintavaWalletWhereInput[] = [
        { wawuUserId: q },
        { accountName: { contains: q, mode: 'insensitive' } },
        { wawuUserId: { in: byHandle.map((p) => p.wawuUserId) } },
      ];
      if (/^\d{3,}$/.test(q)) or.push({ accountNumber: { endsWith: q } });
      and.push({ OR: or });
    }
    if (cursor) {
      and.push({
        OR: [
          { createdAt: { lt: cursor.at } },
          { createdAt: cursor.at, wawuUserId: { lt: cursor.id } },
        ],
      });
    }
    const rows = await this.prisma.fintavaWallet.findMany({
      where: { AND: and },
      orderBy: [{ createdAt: 'desc' }, { wawuUserId: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const handles = await this.handlesOf(page.map((r) => r.wawuUserId));
    const items = page.map((r) =>
      this.toWallet(r, handles.get(r.wawuUserId) ?? null),
    );
    if (withBalance) {
      for (let i = 0; i < page.length; i += BALANCE_PARALLEL) {
        const chunk = page.slice(i, i + BALANCE_PARALLEL);
        const answers = await Promise.all(
          chunk.map((r) => this.askBalance(r.walletId)),
        );
        answers.forEach((a, j) => Object.assign(items[i + j], a));
      }
    }
    const last = page[page.length - 1];
    return {
      items,
      nextCursor:
        rows.length > limit && last
          ? encodeWalletCursor(last.createdAt, last.wawuUserId)
          : null,
    };
  }

  async one(
    wawuId: string,
    query: AdminMoneyPageQueryDto,
  ): Promise<AdminMoneyWalletDetailView> {
    const row = await this.prisma.fintavaWallet.findFirst({
      where: { AND: [{ wawuUserId: wawuId }, rowsOf(this.provider.name)] },
    });
    if (!row)
      throw new NotFoundException(
        'That person has no wallet on this provider.',
      );
    const limit = Math.min(query.limit ?? DEFAULT_LIMIT, 50);
    const cursor = decodeAt(query.cursor);
    const and: Prisma.FintavaLedgerEntryWhereInput[] = [
      { wawuUserId: wawuId, walletKind: 'user' },
      rowsOf(this.provider.name),
    ];
    if (cursor) {
      and.push({
        OR: [
          { occurredAt: { lt: cursor.at } },
          { occurredAt: cursor.at, id: { lt: cursor.id } },
        ],
      });
    }
    const [handles, answer, ledger] = await Promise.all([
      this.handlesOf([wawuId]),
      this.askBalance(row.walletId),
      this.prisma.fintavaLedgerEntry.findMany({
        where: { AND: and },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      }),
    ]);
    const page = ledger.slice(0, limit);
    const records: AdminMoneyLedgerRowView[] = page.map((e) => ({
      id: e.id,
      direction: e.direction,
      status: e.status,
      category: e.category,
      amountKobo: safeKoboNumber(e.amountKobo),
      feeKobo: safeKoboNumber(e.feeKobo),
      totalKobo: safeKoboNumber(e.totalKobo),
      counterpartyName: e.counterpartyName,
      linkKind: e.linkKind,
      linkTitle: e.linkTitle,
      reference: e.customerReference ?? e.fintavaReference,
      occurredAt: e.occurredAt.toISOString(),
    }));
    const last = page[page.length - 1];
    return {
      wallet: { ...this.toWallet(row, handles.get(wawuId) ?? null), ...answer },
      recordsNote: RECORDS_NOTE,
      records,
      nextCursor:
        ledger.length > limit && last
          ? encodeAt(last.occurredAt, last.id)
          : null,
    };
  }

  async merchant(
    query: AdminMoneyPageQueryDto,
  ): Promise<AdminMoneyMerchantView> {
    const limit = Math.min(query.limit ?? DEFAULT_LIMIT, 50);
    const cursor = decodeAt(query.cursor);
    const heldWhere: Prisma.WalletHoldWhereInput = {
      status: 'held',
      provider: this.provider.name,
    };
    const and: Prisma.WalletHoldWhereInput[] = [heldWhere];
    if (cursor) {
      and.push({
        OR: [
          { heldAt: { gt: cursor.at } },
          { heldAt: cursor.at, id: { gt: cursor.id } },
        ],
      });
    }
    const [platform, groups, holds] = await Promise.all([
      this.provider.getPlatformAccount().then(
        (p) => ({ ok: true as const, p }),
        (err: unknown) => ({ ok: false as const, err }),
      ),
      this.prisma.walletHold.groupBy({
        by: ['kind'],
        where: heldWhere,
        _count: { _all: true },
        _sum: { amountKobo: true, payeeShareKobo: true, wawuShareKobo: true },
      }),
      this.prisma.walletHold.findMany({
        where: { AND: and },
        orderBy: [{ heldAt: 'asc' }, { id: 'asc' }],
        take: limit + 1,
      }),
    ]);
    const pageHolds = holds.slice(0, limit);
    const handles = await this.handlesOf(
      pageHolds.flatMap((h) =>
        [h.payerWawuUserId, h.payeeWawuUserId].filter((x): x is string => !!x),
      ),
    );
    const heldByKind: AdminMoneyHeldByKindView[] = groups.map((g) => ({
      kind: g.kind,
      count: g._count._all,
      heldKobo: safeKoboNumber(g._sum.amountKobo ?? 0n),
      payeeShareKobo: safeKoboNumber(g._sum.payeeShareKobo ?? 0n),
      wawuShareKobo: safeKoboNumber(g._sum.wawuShareKobo ?? 0n),
    }));
    const items: AdminMoneyHeldView[] = pageHolds.map((h) => ({
      id: h.id,
      kind: h.kind,
      title: h.title,
      payerWawuId: h.payerWawuUserId,
      payerHandle: h.payerWawuUserId
        ? (handles.get(h.payerWawuUserId) ?? null)
        : null,
      payeeWawuId: h.payeeWawuUserId,
      payeeHandle: h.payeeWawuUserId
        ? (handles.get(h.payeeWawuUserId) ?? null)
        : null,
      amountKobo: safeKoboNumber(h.amountKobo),
      payeeShareKobo: safeKoboNumber(h.payeeShareKobo),
      wawuShareKobo: safeKoboNumber(h.wawuShareKobo),
      heldAt: h.heldAt.toISOString(),
      waiting: h.waiting,
      inReview: h.reviewSince !== null,
    }));
    const last = pageHolds[pageHolds.length - 1];
    const view: AdminMoneyMerchantView = {
      provider: this.provider.name,
      account: null,
      recordsNote: HELD_NOTE,
      heldByKind,
      holds: items,
      nextCursor:
        holds.length > limit && last ? encodeAt(last.heldAt, last.id) : null,
    };
    if (platform.ok) {
      try {
        view.account = {
          accountLast4: last4(platform.p.accountNumber),
          accountName: platform.p.accountName,
          balance: {
            availableKobo: safeKoboNumber(platform.p.availableKobo),
            bookedKobo: safeKoboNumber(platform.p.bookedKobo),
            source: 'provider',
            asOf: new Date().toISOString(),
          },
        };
      } catch {
        view.balanceUnavailable = BALANCE_TOO_LARGE;
      }
    } else {
      this.logger.warn('admin merchant balance: the provider did not answer');
      view.balanceUnavailable = BALANCE_NO_ANSWER;
    }
    return view;
  }
}

/** The wallets list orders by (createdAt, wawuUserId); a WAWU id is not always a UUID, so it has its own cursor. */
function encodeWalletCursor(at: Date, id: string): string {
  return Buffer.from(JSON.stringify([at.getTime(), id])).toString('base64url');
}

function decodeWalletCursor(
  raw: string | undefined,
): { at: Date; id: string } | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(raw, 'base64url').toString(),
    );
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      Number.isSafeInteger(parsed[0]) &&
      typeof parsed[1] === 'string' &&
      parsed[1].length > 0
    ) {
      return { at: new Date(parsed[0] as number), id: parsed[1] };
    }
  } catch {
    // falls through to the refusal
  }
  throw new BadRequestException('cursor is not one this list gave.');
}
