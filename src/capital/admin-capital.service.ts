import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import type {
  CapitalOrder as OrderRow,
  Prisma,
} from '../../generated/prisma/client';
import type { AdminUserView } from '../admin/auth/admin-user-view.type';
import { PrismaService } from '../common/prisma/prisma.service';
import { statusOf } from './capital-mapping';
import type { CapitalOrderStatus } from './capital-view.type';

/** One order as the dashboard lists it: ids and figures, never a name, phone or number. */
export interface AdminCapitalOrderView {
  id: string;
  wawuUserId: string;
  productName: string;
  kind: 'fixed_return' | 'share_offering';
  state: string;
  status: CapitalOrderStatus;
  lifecycle: string | null;
  amountKobo: number;
  totalKobo: number;
  feeKobo: number;
  feeState: string;
  frozen: boolean;
  frozenReason: string | null;
  createdAt: string;
  confirmedAt: string | null;
  expiresAt: string | null;
  lastAct: { action: string; at: string; adminEmail: string } | null;
}

export interface AdminCapitalPage {
  items: AdminCapitalOrderView[];
  nextCursor: string | null;
}

export type AdminCapitalAction = 'freeze' | 'unfreeze' | 'cancel';

/**
 * The dashboard's hands on Capital orders (task NUV-12): list them, hold one
 * (freeze), let one go (unfreeze), or cancel a reservation that has not been
 * confirmed. Each act writes an audit row with the admin's id, email and
 * role. Nuvion has no call to cancel or hold an investment that is made, so
 * a freeze is WAWU's: the person cannot start a withdrawal or confirm until it
 * is lifted. Cancelling is only for a reservation (nothing taken yet).
 */
@Injectable()
export class AdminCapitalService {
  constructor(private readonly prisma: PrismaService) {}

  private view(
    row: OrderRow,
    last: { action: string; createdAt: Date; adminEmail: string } | undefined,
    now: Date,
  ): AdminCapitalOrderView {
    const fee = Number(row.feeKobo);
    return {
      id: row.id,
      wawuUserId: row.wawuUserId,
      productName: row.productName,
      kind:
        row.productType === 'SHARE_OFFERING'
          ? 'share_offering'
          : 'fixed_return',
      state: row.state,
      status: statusOf(row, now),
      lifecycle: row.lifecycle,
      amountKobo: Number(row.amountMinor),
      totalKobo: Number(row.totalDebitMinor ?? row.amountMinor) + fee,
      feeKobo: fee,
      feeState: row.feeState,
      frozen: row.frozenAt !== null,
      frozenReason: row.frozenReason,
      createdAt: row.createdAt.toISOString(),
      confirmedAt: row.confirmedAt ? row.confirmedAt.toISOString() : null,
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      lastAct: last
        ? {
            action: last.action,
            at: last.createdAt.toISOString(),
            adminEmail: last.adminEmail,
          }
        : null,
    };
  }

  async list(q: {
    state?: string;
    wawuUserId?: string;
    cursor?: string;
    limit?: number;
  }): Promise<AdminCapitalPage> {
    const take = Math.min(q.limit ?? 25, 100);
    const where: Prisma.CapitalOrderWhereInput = {
      NOT: { nuvionOrderId: null },
    };
    if (q.state) where.state = q.state;
    if (q.wawuUserId) where.wawuUserId = q.wawuUserId;
    const rows = await this.prisma.capitalOrder.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, take);
    const acts = await this.prisma.capitalAdminAudit.findMany({
      where: { orderId: { in: page.map((r) => r.id) } },
      orderBy: { createdAt: 'desc' },
    });
    const now = new Date();
    return {
      items: page.map((r) =>
        this.view(
          r,
          acts.find((a) => a.orderId === r.id),
          now,
        ),
      ),
      nextCursor: rows.length > take ? page[page.length - 1].id : null,
    };
  }

  async act(
    admin: AdminUserView,
    id: string,
    action: AdminCapitalAction,
    note: string | undefined,
  ): Promise<AdminCapitalOrderView> {
    const row = await this.prisma.capitalOrder.findUnique({ where: { id } });
    if (!row || row.nuvionOrderId === null)
      throw new NotFoundException('No such order.');
    const now = new Date();
    const text = note?.trim() ? note.trim().slice(0, 300) : null;

    let updated: OrderRow;
    if (action === 'freeze') {
      if (['expired', 'rejected', 'cancelled', 'failed'].includes(row.state)) {
        throw new ConflictException(
          'That order has ended; there is nothing to hold.',
        );
      }
      updated = await this.prisma.capitalOrder.update({
        where: { id },
        data: {
          frozenAt: row.frozenAt ?? now,
          frozenReason: text ?? row.frozenReason,
        },
      });
    } else if (action === 'unfreeze') {
      if (row.frozenAt === null)
        throw new ConflictException('That order is not on hold.');
      updated = await this.prisma.capitalOrder.update({
        where: { id },
        data: { frozenAt: null, frozenReason: null },
      });
    } else {
      // Only a reservation: the provider has no call to undo an investment that is made.
      const { count } = await this.prisma.capitalOrder.updateMany({
        where: { id, state: 'reserved' },
        data: { state: 'cancelled', cancelledAt: now },
      });
      if (count !== 1) {
        throw new ConflictException(
          row.state === 'cancelled'
            ? 'That order is already cancelled.'
            : 'Only a reservation can be cancelled. Hold an invested order instead.',
        );
      }
      updated = (await this.prisma.capitalOrder.findUnique({ where: { id } }))!;
    }

    // The audit row is written after the act, as every admin audit here is: a
    // missing row is a gap in a record, never a reason to undo the act.
    const audit = await this.prisma.capitalAdminAudit.create({
      data: {
        orderId: id,
        subjectWawuId: row.wawuUserId,
        action,
        note: text,
        adminId: admin.id,
        adminEmail: admin.email,
        adminRole: admin.role,
      },
    });
    return this.view(updated, audit, now);
  }
}
