import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import { WawuIdClient } from '../../common/auth/wawu-id.client';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { HoldListQueryDto } from '../dto/money-request.dto';
import type { PaymentKind } from '../dto/money-enums';
import { MoneyError } from '../money-error';
import { koboNumber } from '../ledger/ledger.service';
import { loadMoneyParties } from '../money-party';
import type {
  HoldPage,
  HoldReleaseCondition,
  HoldStatus,
  HoldView,
  MoneyPartyView,
} from '../money-view.type';
import { decodeHoldCursor, encodeHoldCursor } from './hold-cursor';
import { COUNTERPARTY_FALLBACK_NAMES } from '../history/history-labels';

export type HoldRow = Prisma.WalletHoldGetPayload<object>;

/**
 * A hold as the app reads it (`HoldView`, task MONEY-18): the held price,
 * what releases it, who paid and who is owed, and when it was released or
 * refunded. One WAWU ID call and one profile query for a whole page.
 *
 * Money figures come from the hold's own row; nothing here is added up into
 * a balance (the provider's balance is the only one, MONEY-11).
 */
@Injectable()
export class HoldViewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wawuId: WawuIdClient,
  ) {}

  /**
   * The caller's holds, newest first: the ones they paid (`payer`) or are
   * owed (`payee`). A page that is exactly full carries no cursor when
   * nothing follows.
   */
  async list(
    wawuUserId: string,
    query: Pick<HoldListQueryDto, 'role' | 'cursor' | 'limit'>,
  ): Promise<HoldPage> {
    const limit = query.limit ?? 20;
    const cursor = query.cursor ? decodeHoldCursor(query.cursor) : null;
    const rows = await this.prisma.walletHold.findMany({
      where: {
        ...(query.role === 'payer'
          ? { payerWawuUserId: wawuUserId }
          : { payeeWawuUserId: wawuUserId }),
        ...(cursor
          ? {
              OR: [
                { heldAt: { lt: cursor.at } },
                { heldAt: cursor.at, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ heldAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: await this.views(page),
      nextCursor:
        rows.length > limit && last
          ? encodeHoldCursor({ at: last.heldAt, id: last.id })
          : null,
    };
  }

  /** One hold, for its payer or its payee; anybody else is `404 not_found`. */
  async detail(wawuUserId: string, id: string): Promise<HoldView> {
    const row = await this.prisma.walletHold.findUnique({ where: { id } });
    if (
      !row ||
      (row.payerWawuUserId !== wawuUserId && row.payeeWawuUserId !== wawuUserId)
    ) {
      throw new MoneyError('not_found', 'We could not find that.');
    }
    return (await this.views([row]))[0];
  }

  /** The hold of a payment, or null when it has none (a kind that is not held, or not completed). */
  async forPayment(paymentId: string): Promise<HoldView | null> {
    const row = await this.prisma.walletHold.findUnique({
      where: { paymentId },
    });
    if (!row) return null;
    return (await this.views([row]))[0];
  }

  /** Views in the order of `rows`. */
  async views(rows: readonly HoldRow[]): Promise<HoldView[]> {
    const ids = [
      ...new Set(
        rows
          .flatMap((r) => [r.payerWawuUserId, r.payeeWawuUserId])
          .filter((id): id is string => !!id),
      ),
    ];
    let parties = new Map<string, MoneyPartyView>();
    try {
      parties = await loadMoneyParties(this.prisma, this.wawuId, ids);
    } catch {
      // A name is never worth a failed answer: the party reads from its id.
    }
    return rows.map((r) => this.view(r, parties));
  }

  private view(r: HoldRow, parties: Map<string, MoneyPartyView>): HoldView {
    const person = (id: string | null): MoneyPartyView | null =>
      id === null ? null : (parties.get(id) ?? bare(id));
    return {
      id: r.id,
      paymentId: r.paymentId,
      kind: r.kind as PaymentKind,
      status: r.status as HoldStatus,
      amountKobo: koboNumber(r.amountKobo),
      releaseCondition: r.releaseCondition as HoldReleaseCondition,
      // The payer's account can be gone while WAWU still holds the money.
      payer: person(r.payerWawuUserId) ?? gone(),
      payee: person(r.payeeWawuUserId),
      heldAt: r.heldAt.toISOString(),
      settledAt: r.settledAt ? r.settledAt.toISOString() : null,
      refundedKobo: r.refundedKobo === null ? null : koboNumber(r.refundedKobo),
    };
  }
}

/** A person nothing could name (WAWU ID and the profile both silent). */
function bare(id: string): MoneyPartyView {
  return {
    wawuUserId: id,
    displayName: '',
    handle: null,
    avatarUrl: null,
    tick: null,
  };
}

/** The payer of a hold whose account was deleted. */
function gone(): MoneyPartyView {
  return {
    wawuUserId: '',
    displayName: COUNTERPARTY_FALLBACK_NAMES.wawu_user,
    handle: null,
    avatarUrl: null,
    tick: null,
  };
}
