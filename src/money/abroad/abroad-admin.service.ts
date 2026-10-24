import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import { WalletProviderError } from '../../wallet-provider/wallet-provider-error';
import { MoneyError } from '../money-error';
import { AbroadService, providerError } from './abroad.service';
import {
  AbroadSendService,
  decodeCursor,
  encodeCursor,
  LOOK_AFTER_MS,
  SEND_CANCELLED_REASON,
  SEND_NOT_FOUND_MESSAGE,
} from './abroad-send.service';
import type {
  AbroadSendStatus,
  AdminAbroadCancelView,
  AdminAbroadFreezeView,
  AdminAbroadSendPage,
  AdminAbroadSendView,
} from './abroad-view.type';
import type { AdminAbroadSendsQueryDto } from './dto/abroad-request.dto';

/** The acting admin: the three fields an audit row needs (AdminUserView satisfies it). */
export interface AbroadAdminActor {
  id: string;
  email: string;
  role: string;
}

type Row = Prisma.AbroadSendGetPayload<{ include: { recipient: true } }>;

/**
 * What the dashboard does with sends abroad (task NUV-11): list and read them
 * (superadmin and finance), freeze or let go of a person, and cancel a send
 * the provider never received. Each write leaves an `AbroadAdminAudit` row
 * (who, what, why, when). Nothing here moves money, and nothing here tells
 * the provider to stop a payout: it has no way to (dev answers 404 to every
 * cancel), so a send it holds is `send_not_cancellable`.
 */
@Injectable()
export class AbroadAdminService {
  private readonly logger = new Logger(AbroadAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(WALLET_PROVIDER) private readonly walletProvider: WalletProvider,
    private readonly abroad: AbroadService,
    private readonly sends: AbroadSendService,
  ) {}

  async list(q: AdminAbroadSendsQueryDto): Promise<AdminAbroadSendPage> {
    const limit = q.limit ?? 20;
    const at = decodeCursor(q.cursor);
    const rows = await this.prisma.abroadSend.findMany({
      where: {
        ...(q.wawuUserId ? { wawuUserId: q.wawuUserId } : {}),
        ...(q.status ? { status: q.status } : {}),
        ...(at
          ? {
              OR: [
                { createdAt: { lt: at.createdAt } },
                { createdAt: at.createdAt, id: { lt: at.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: { recipient: true },
    });
    const page = rows.slice(0, limit);
    const frozen = await this.frozenAmong(page.map((r) => r.wawuUserId));
    const last = page[page.length - 1];
    return {
      items: page.map((r) => this.view(r, frozen.has(r.wawuUserId))),
      nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
    };
  }

  async get(id: string): Promise<AdminAbroadSendView> {
    const row = await this.row(id);
    const frozen = await this.frozenAmong([row.wawuUserId]);
    return this.view(row, frozen.has(row.wawuUserId));
  }

  private async row(id: string): Promise<Row> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      throw new MoneyError('not_found', SEND_NOT_FOUND_MESSAGE);
    }
    const row = await this.prisma.abroadSend.findUnique({
      where: { id },
      include: { recipient: true },
    });
    if (!row) throw new MoneyError('not_found', SEND_NOT_FOUND_MESSAGE);
    return row;
  }

  private async frozenAmong(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.prisma.abroadFreeze.findMany({
      where: { wawuUserId: { in: ids } },
      select: { wawuUserId: true },
    });
    return new Set(rows.map((r) => r.wawuUserId));
  }

  private view(r: Row, personFrozen: boolean): AdminAbroadSendView {
    return {
      id: r.id,
      wawuUserId: r.wawuUserId,
      status: r.status as AbroadSendStatus,
      recipientName: r.recipient.holderName,
      country: r.recipient.country,
      fromCurrency: r.fromCurrency,
      toCurrency: r.toCurrency,
      amountFromMinor: Number(r.amountFromMinor),
      amountToMinor: Number(r.amountToMinor),
      providerFeeMinor:
        r.providerFeeMinor === null ? null : Number(r.providerFeeMinor),
      wawuFeeKobo: Number(r.wawuFeeKobo),
      wawuFeeOwed: !r.wawuFeeTaken,
      wawuFeeBackOwed:
        r.wawuFeeTaken &&
        r.wawuFeeKobo > 0n &&
        (r.status === 'failed' || r.status === 'reversed') &&
        r.feeGivenBackAt === null,
      providerFeeEstimateMinor:
        r.providerFeeEstimateMinor === null
          ? null
          : Number(r.providerFeeEstimateMinor),
      feeDiffers: r.feeDiffers,
      reference: r.reference,
      providerStatus: r.providerStatus,
      failureReason: r.failureReason,
      personFrozen,
      createdAt: r.createdAt.toISOString(),
      completedAt: r.completedAt ? r.completedAt.toISOString() : null,
    };
  }

  // -- the writes --------------------------------------------------------------

  async freeze(
    admin: AbroadAdminActor,
    wawuUserId: string,
    reason: string,
  ): Promise<AdminAbroadFreezeView> {
    const existing = await this.prisma.abroadFreeze.findUnique({
      where: { wawuUserId },
    });
    if (existing) return this.freezeView(wawuUserId, existing);
    const row = await this.prisma.$transaction(async (tx) => {
      const made = await tx.abroadFreeze.upsert({
        where: { wawuUserId },
        create: { wawuUserId, reason, byAdminId: admin.id },
        update: {},
      });
      await tx.abroadAdminAudit.create({
        data: {
          action: 'person_frozen',
          subjectWawuId: wawuUserId,
          reason,
          adminId: admin.id,
          adminEmail: admin.email,
          adminRole: admin.role,
        },
      });
      return made;
    });
    return this.freezeView(wawuUserId, row);
  }

  async unfreeze(
    admin: AbroadAdminActor,
    wawuUserId: string,
    reason: string,
  ): Promise<AdminAbroadFreezeView> {
    const existing = await this.prisma.abroadFreeze.findUnique({
      where: { wawuUserId },
    });
    if (!existing) return this.freezeView(wawuUserId, null);
    await this.prisma.$transaction([
      this.prisma.abroadFreeze.delete({ where: { wawuUserId } }),
      this.prisma.abroadAdminAudit.create({
        data: {
          action: 'person_unfrozen',
          subjectWawuId: wawuUserId,
          reason,
          detail: { frozenReason: existing.reason },
          adminId: admin.id,
          adminEmail: admin.email,
          adminRole: admin.role,
        },
      }),
    ]);
    return this.freezeView(wawuUserId, null);
  }

  private freezeView(
    wawuUserId: string,
    row: { reason: string; frozenAt: Date } | null,
  ): AdminAbroadFreezeView {
    return {
      wawuUserId,
      frozen: row !== null,
      reason: row?.reason ?? null,
      at: row ? row.frozenAt.toISOString() : null,
    };
  }

  /**
   * Cancels a send the provider never received. A send that is `sending` or
   * `needs_review` is first looked for at the provider by its reference with
   * a complete search: a record found settles the send as the provider says
   * and the cancel is refused; a search that cannot be completed is refused
   * too (silence is never proof). Only a complete search that finds nothing
   * lets the cancel stand. Any other send is held by the provider, which
   * cannot stop it.
   */
  async cancel(
    admin: AbroadAdminActor,
    id: string,
    reason: string,
  ): Promise<AdminAbroadCancelView> {
    const row = await this.row(id);
    if (row.status === 'cancelled') return { id, status: 'cancelled' };
    // A send seconds old may still be on its way to the provider: it is looked for only once the sweep would look (F3).
    if (
      Date.now() - (row.attemptedAt ?? row.createdAt).getTime() <
      LOOK_AFTER_MS
    ) {
      throw new MoneyError(
        'send_not_cancellable',
        'This send is too new to cancel: the payment partner may still be taking it. Try again in a minute.',
      );
    }
    const holdsIt =
      row.providerTransferId !== null ||
      !['sending', 'needs_review'].includes(row.status);
    if (holdsIt) {
      throw new MoneyError(
        'send_not_cancellable',
        'The payment partner already has this send and cannot stop it.',
      );
    }
    const holder = await this.abroad.holderOf(row.wawuUserId);
    if (!holder) {
      throw new MoneyError(
        'send_not_cancellable',
        'We cannot ask the payment partner about this send yet. Try again later.',
      );
    }
    let found;
    try {
      found = await this.abroad
        .provider()
        .findByReference(
          holder,
          row.reference,
          row.attemptedAt ?? row.createdAt,
        );
    } catch (e) {
      if (e instanceof WalletProviderError) {
        throw new MoneyError(
          'send_not_cancellable',
          'We cannot ask the payment partner about this send yet. Try again later.',
        );
      }
      return providerError(e);
    }
    if (found.state === 'found') {
      await this.sends.apply(row.id, found.transfer);
      throw new MoneyError(
        'send_not_cancellable',
        'The payment partner already has this send and cannot stop it.',
      );
    }
    if (found.state === 'unknown') {
      throw new MoneyError(
        'send_not_cancellable',
        'We cannot tell yet whether the payment partner has this send. Try again later.',
      );
    }
    await this.prisma.$transaction(async (tx) => {
      // The row is locked while it is judged and changed, so a send that the provider takes and records at the same moment is not
      // cancelled under it: the count below is zero, or `apply` finds the row cancelled and never reopens it.
      await tx.$queryRaw`SELECT "id" FROM "AbroadSend" WHERE "id" = ${id} FOR UPDATE`;
      const { count } = await tx.abroadSend.updateMany({
        where: {
          id,
          status: { in: ['sending', 'needs_review'] },
          providerTransferId: null,
        },
        data: {
          status: 'cancelled',
          failureReason: SEND_CANCELLED_REASON,
          completedAt: new Date(),
        },
      });
      if (count !== 1) {
        throw new MoneyError(
          'send_not_cancellable',
          'This send changed while it was being cancelled. Look at it again.',
        );
      }
      await tx.abroadAdminAudit.create({
        data: {
          action: 'send_cancelled',
          subjectWawuId: row.wawuUserId,
          sendId: id,
          reason,
          detail: { statusBefore: row.status },
          adminId: admin.id,
          adminEmail: admin.email,
          adminRole: admin.role,
        },
      });
    });
    return { id, status: 'cancelled' };
  }
}
