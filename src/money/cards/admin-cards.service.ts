import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import {
  AdminOpsAction,
  AdminOpsResource,
} from '../../../generated/prisma/enums';
import {
  type AdminActor,
  AdminOpsAuditService,
} from '../../common/audit/admin-ops-audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import type { OpenWallet } from '../gate/wallet-gate';
import type { AdminCardsQueryDto } from './card-request.dto';
import { CARDS_ENABLED_SETTING, CardSettings } from './card-config';
import type {
  AdminCardPage,
  AdminCardSettingsView,
  AdminCardView,
  CardView,
} from './card-view.type';
import { MoneyError } from '../money-error';
import {
  cardView,
  USED_MESSAGE,
  WalletCardService,
} from './wallet-card.service';

type Row = Prisma.WalletCardGetPayload<object>;

function view(row: Row): AdminCardView {
  return {
    id: row.id,
    wawuUserId: row.wawuUserId,
    kind: row.type === 'single_use' ? 'single_use' : 'virtual',
    state: row.state,
    frozenBy: row.frozenBy,
    providerCardId: row.providerCardId,
    createdAt: row.createdAt.toISOString(),
    cancelledAt: row.cancelledAt ? row.cancelledAt.toISOString() : null,
  };
}

function readCursor(raw: string | undefined): { at: Date; id: string } | null {
  if (!raw) return null;
  const [at, id] = raw.split('|');
  const date = new Date(at ?? '');
  return id && !Number.isNaN(date.getTime()) ? { at: date, id } : null;
}

/**
 * Support's side of the WAWU card (task WALLET-31, owner-asked controls):
 * list the cards on the system, and freeze, unfreeze or block one for a
 * person. By account id only: no name, number, expiry, CVV or phone is ever
 * read or returned here. Every action is audited (AdminOpsAudit: who, which
 * card, whose account, the state before and after).
 */
@Injectable()
export class AdminCardsService {
  private readonly logger = new Logger(AdminCardsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cards: WalletCardService,
    private readonly audit: AdminOpsAuditService,
    private readonly settings: CardSettings,
    private readonly plan: PlanSettingsService,
  ) {}

  /** The switch, the two fees and the two counts in force (task OPS-27). Read only. */
  cardSettings(): AdminCardSettingsView {
    let enabled = false;
    try {
      enabled = this.plan.number(CARDS_ENABLED_SETTING) === 1;
    } catch {
      // A switch that cannot be read is shown off, as the card routes treat it.
    }
    return {
      enabled,
      providerFeeKobo: this.settings.providerFeeKobo,
      wawuFeeKobo: this.settings.wawuFeeKobo,
      maxActive: this.settings.maxActive,
      maxPerDay: this.settings.maxPerDay,
    };
  }

  async list(query: AdminCardsQueryDto): Promise<AdminCardPage> {
    const limit = query.limit ?? 20;
    const cursor = readCursor(query.cursor);
    const where: Prisma.WalletCardWhereInput = {
      ...(query.state ? { state: query.state } : {}),
      ...(query.wawuUserId ? { wawuUserId: query.wawuUserId } : {}),
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: cursor.at } },
              { createdAt: cursor.at, id: { lt: cursor.id } },
            ],
          }
        : {}),
    };
    const rows = await this.prisma.walletCard.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(view),
      nextCursor:
        rows.length > limit && last
          ? `${last.createdAt.toISOString()}|${last.id}`
          : null,
    };
  }

  freeze(actor: AdminActor, id: string): Promise<CardView> {
    return this.act(
      actor,
      id,
      'admin-freeze',
      AdminOpsAction.wallet_card_frozen,
    );
  }

  unfreeze(actor: AdminActor, id: string): Promise<CardView> {
    return this.act(
      actor,
      id,
      'admin-unfreeze',
      AdminOpsAction.wallet_card_unfrozen,
    );
  }

  cancel(actor: AdminActor, id: string): Promise<CardView> {
    return this.act(actor, id, 'block', AdminOpsAction.wallet_card_cancelled);
  }

  private async act(
    actor: AdminActor,
    id: string,
    action: 'admin-freeze' | 'admin-unfreeze' | 'block',
    audited: AdminOpsAction,
  ): Promise<CardView> {
    const row = await this.prisma.walletCard.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('That card does not exist.');
    const wallet = await this.prisma.fintavaWallet.findUnique({
      where: { wawuUserId: row.wawuUserId },
      select: { customerId: true, walletId: true, accountNumber: true },
    });
    if (!wallet) {
      throw new NotFoundException(
        'That card belongs to an account with no wallet.',
      );
    }
    const open: OpenWallet = { wawuUserId: row.wawuUserId, ...wallet };
    // A used single-use card is already unusable: nothing is blocked, so it is refused in the Hub's own shape and no audit row says
    // otherwise (SWEEP-MONEY-6, WALLET-31 L6, lead ruling).
    if (row.state === 'used') {
      throw new MoneyError('card_blocked', USED_MESSAGE);
    }
    // A repeat changes nothing and is not audited a second time (round 1, L6).
    if (
      (action === 'admin-freeze' &&
        row.state === 'frozen' &&
        row.frozenBy === 'admin') ||
      (action === 'admin-unfreeze' && row.state === 'active') ||
      (action === 'block' && row.state === 'cancelled')
    ) {
      return cardView(row);
    }
    const done = await this.cards.control(open, id, action);
    this.logger.log(`card ${id} ${action} by support: admin ${actor.id}`);
    await this.audit.record(actor, {
      resource: AdminOpsResource.wallet_card,
      resourceId: id,
      subjectWawuId: row.wawuUserId,
      action: audited,
      detail: { stateBefore: row.state, stateAfter: done.status },
    });
    return done;
  }
}
