import { Injectable, Logger } from '@nestjs/common';
import type { FxOperation } from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { MoneyError } from '../money-error';
import type { AdminUserView } from '../../admin/auth/admin-user-view.type';
import type {
  ProviderFxAccount,
  ProviderFxChain,
} from '../../wallet-provider/wallet-provider-fx';
import type { AdminFxOperationsQueryDto } from './dto/fx-request.dto';
import type { FxChain, FxQuoteCode } from './fx-currencies';
import { FxPort } from './fx-provider';
import { FxSettings } from './fx-settings';
import { accountView, num, numOrNull } from './fx-views';
import type {
  AdminFxAccountListView,
  AdminFxFreezeView,
  AdminFxOperationPage,
  AdminFxOperationView,
} from './fx-view.type';

interface Cursor {
  t: string;
  id: string;
}

function encode(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}
function decode(raw: string): Cursor | null {
  try {
    const c = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8'),
    ) as Partial<Cursor>;
    if (
      typeof c.t === 'string' &&
      typeof c.id === 'string' &&
      !Number.isNaN(Date.parse(c.t))
    ) {
      return c as Cursor;
    }
  } catch {
    // falls through
  }
  return null;
}

export function operationView(o: FxOperation): AdminFxOperationView {
  return {
    id: o.id,
    kind: o.kind as 'swap' | 'send',
    status: o.status as AdminFxOperationView['status'],
    wawuUserId: o.wawuUserId,
    fromCurrency: o.fromCurrency as FxQuoteCode,
    toCurrency: (o.toCurrency as FxQuoteCode | null) ?? null,
    amountFromMinor: num(o.amountFromMinor),
    amountToMinor: numOrNull(o.amountToMinor),
    providerFeeMinor: numOrNull(o.providerFeeMinor),
    wawuFeeMinor: num(o.wawuFeeMinor),
    feeLeg:
      o.feeLeg === 'done' || o.feeLeg === 'uncollected'
        ? o.feeLeg
        : o.feeLeg
          ? 'owed'
          : null,
    chain: (o.chain as FxChain | null) ?? null,
    address: o.address,
    reference: o.reference,
    failureReason: o.failureReason,
    createdAt: o.createdAt.toISOString(),
    completedAt: o.completedAt?.toISOString() ?? null,
  };
}

/**
 * What the admin dashboard reads of foreign accounts, swaps and sends, and
 * freezing one account (task WALLET-21, R-84). Superadmin and finance only (the
 * controller says so). A freeze changes WAWU's own record and leaves one audit
 * row; it moves no money and tells the provider nothing.
 */
@Injectable()
export class FxAdminService {
  private readonly logger = new Logger(FxAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly port: FxPort,
    private readonly settings: FxSettings,
  ) {}

  async personAccounts(wawuUserId: string): Promise<AdminFxAccountListView> {
    const rows = await this.prisma.fxAccount.findMany({
      where: { wawuUserId },
      orderBy: { createdAt: 'asc' },
    });
    const wallet = await this.prisma.fintavaWallet.findUnique({
      where: { wawuUserId },
    });
    const canRead =
      this.port.supported &&
      wallet?.provider === this.port.name &&
      !!wallet.walletId;
    const accounts = await Promise.all(
      rows.map(async (r) => {
        let balance: ProviderFxAccount | null = null;
        let details = null;
        if (canRead && r.providerAccountId && r.provider === this.port.name) {
          const person = {
            customerId: wallet.customerId,
            walletId: wallet.walletId,
          };
          const fx = this.port.get();
          balance = await fx
            .readAccount(person, r.providerAccountId)
            .catch(() => null);
          details = await fx
            .readDetails(
              person,
              {
                accountId: r.providerAccountId,
                currency: r.currency,
                chain: (r.chain || null) as ProviderFxChain | null,
              },
              false,
            )
            .then((read) => read.details)
            .catch(() => null);
        }
        return {
          ...accountView(r, this.settings, balance, details),
          wawuUserId: r.wawuUserId,
          frozenAt: r.frozenAt?.toISOString() ?? null,
          frozenReason: r.frozenReason,
        };
      }),
    );
    return { wawuUserId, accounts };
  }

  async operations(
    q: AdminFxOperationsQueryDto,
  ): Promise<AdminFxOperationPage> {
    const limit = q.limit ?? 20;
    const cur = q.cursor ? decode(q.cursor) : null;
    const rows = await this.prisma.fxOperation.findMany({
      where: {
        ...(q.wawuUserId ? { wawuUserId: q.wawuUserId } : {}),
        ...(q.kind ? { kind: q.kind } : {}),
        ...(q.status ? { status: q.status } : {}),
        ...(cur
          ? {
              OR: [
                { createdAt: { lt: new Date(cur.t) } },
                { createdAt: new Date(cur.t), id: { lt: cur.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(operationView),
      nextCursor:
        rows.length > limit && last
          ? encode({ t: last.createdAt.toISOString(), id: last.id })
          : null,
    };
  }

  async operation(id: string): Promise<AdminFxOperationView> {
    const o = await this.prisma.fxOperation.findUnique({ where: { id } });
    if (!o) throw new MoneyError('not_found', 'We could not find that.');
    return operationView(o);
  }

  /** Freezes (`freeze`) or lets go (`unfreeze`) one account; a repeat changes nothing and leaves no second row. */
  async setFrozen(
    admin: AdminUserView,
    id: string,
    action: 'freeze' | 'unfreeze',
    reason: string,
  ): Promise<AdminFxFreezeView> {
    const out = await this.prisma.$transaction(async (tx) => {
      const row = await tx.fxAccount.findUnique({ where: { id } });
      if (!row)
        throw new MoneyError('not_found', 'We could not find that account.');
      const wants = action === 'freeze' ? 'frozen' : 'open';
      if (row.status === 'opening') {
        throw new MoneyError(
          'fx_account_not_open',
          'That account is not open yet.',
        );
      }
      if (row.status === wants) return row;
      const updated = await tx.fxAccount.update({
        where: { id },
        data:
          action === 'freeze'
            ? { status: 'frozen', frozenAt: new Date(), frozenReason: reason }
            : { status: 'open', frozenAt: null, frozenReason: null },
      });
      await tx.fxAdminAudit.create({
        data: {
          fxAccountId: id,
          subjectWawuId: row.wawuUserId,
          action,
          reason,
          actedByAdminId: admin.id,
          actedByAdminEmail: admin.email,
          actedByAdminRole: admin.role,
        },
      });
      return updated;
    });
    this.logger.log(`fx account ${id}: ${action} by admin ${admin.id}`);
    return {
      accountId: out.id,
      wawuUserId: out.wawuUserId,
      status: out.status === 'frozen' ? 'frozen' : 'open',
      frozenAt: out.frozenAt?.toISOString() ?? null,
      frozenReason: out.frozenReason,
    };
  }
}
