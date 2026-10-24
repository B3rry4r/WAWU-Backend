import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { AdminUserView } from '../../admin/auth/admin-user-view.type';
import { PrismaService } from '../../common/prisma/prisma.service';
import { MoneyError } from '../money-error';
import { CANCELLED_BY_ADMIN, releasedBvnHash } from '../opening/bvn-claim';
import { reviewStageOf } from '../opening/review-stage';
import { type Cursor, decode, encode } from '../fx/fx-admin.service';
import type { AdminWorldOpeningsQueryDto } from './dto/world-request.dto';
import { isFiatCode } from './world-countries';
import type {
  AdminWorldActView,
  AdminWorldOpeningPage,
  AdminWorldOpeningView,
} from './world-view.type';

/** The prefix of a foreign account's frozen reason when the world freeze made it. */
export const WORLD_FREEZE_PREFIX = 'world wallet frozen: ';

/** The page cursor is the foreign accounts' own (`{ t, id }`, fx-admin.service.ts): one shape for both lists. */
function decodeCursor(raw: string): Cursor {
  const c = decode(raw);
  if (!c) throw new BadRequestException('cursor is not one this list gave');
  return c;
}

type Row = {
  wawuUserId: string;
  bvnHash: string;
  state: string;
  failure: string | null;
  worldCountry: string | null;
  worldFirstCurrency: string | null;
  worldAccountOpenedAt: Date | null;
  worldFrozenAt: Date | null;
  worldFrozenReason: string | null;
  worldCancelledAt: Date | null;
  createdAt: Date;
};
type Entity = {
  status: string;
  decidedAt: Date | null;
  correctedAt: Date | null;
  bvnStatus: string | null;
  ninStatus: string | null;
  documentStatus: string | null;
  addressProofStatus: string | null;
  rejectionReasons: string[];
} | null;

/** The one stage word support reads, from the opening row and Nuvion's review. */
export function worldStageOf(row: Row, entity: Entity): string {
  if (row.worldCancelledAt) return 'cancelled';
  if (row.worldFrozenAt) return 'frozen';
  if (row.worldAccountOpenedAt) return 'open';
  if (row.state === 'expired') return 'expired';
  if (!entity) return 'started';
  switch (reviewStageOf(entity)) {
    case 'needs_documents':
      return 'needs_documents';
    case 'checking':
      return 'checking';
    case 'approved':
      return 'approved';
    case 'rejected':
      return 'rejected';
    case 'stopped':
      return 'stopped';
  }
}

const ROW_SELECT = {
  wawuUserId: true,
  bvnHash: true,
  state: true,
  failure: true,
  worldCountry: true,
  worldFirstCurrency: true,
  worldAccountOpenedAt: true,
  worldFrozenAt: true,
  worldFrozenReason: true,
  worldCancelledAt: true,
  createdAt: true,
} as const;

const ENTITY_SELECT = {
  status: true,
  decidedAt: true,
  correctedAt: true,
  bvnStatus: true,
  ninStatus: true,
  documentStatus: true,
  addressProofStatus: true,
  rejectionReasons: true,
} as const;

/**
 * What the admin dashboard sees of people outside Nigeria who opened, or are
 * opening, a wallet without a BVN (task WALLET-41, R-87), and the two things
 * support can do: freeze (or let go of) a person's world wallet, and cancel
 * an opening that is not open yet. Superadmin and finance only (the
 * controller says so). Each act changes WAWU's own records and leaves one
 * audit row in the same transaction; nothing here moves money or tells the
 * provider anything. No name, document or number is read or returned.
 */
@Injectable()
export class WorldAdminService {
  private readonly logger = new Logger(WorldAdminService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(
    query: AdminWorldOpeningsQueryDto,
  ): Promise<AdminWorldOpeningPage> {
    const limit = query.limit ?? 25;
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    const rows = await this.prisma.fintavaWalletOpening.findMany({
      where: {
        worldCountry: query.country ?? { not: null },
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: new Date(cursor.t) } },
                {
                  createdAt: new Date(cursor.t),
                  wawuUserId: { lt: cursor.id },
                },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { wawuUserId: 'desc' }],
      // A stage filter is applied after the stage is worked out, so a page
      // may need more rows than it shows.
      take: query.stage ? 200 : limit + 1,
      select: ROW_SELECT,
    });
    const entities = await this.prisma.nuvionEntity.findMany({
      where: { wawuUserId: { in: rows.map((r) => r.wawuUserId) } },
      select: { wawuUserId: true, ...ENTITY_SELECT },
    });
    const byId = new Map(entities.map((e) => [e.wawuUserId, e]));
    let views = rows.map((r) => this.view(r, byId.get(r.wawuUserId) ?? null));
    if (query.stage) views = views.filter((v) => v.stage === query.stage);
    const page = views.slice(0, limit);
    const more = views.length > limit;
    const last = page[page.length - 1];
    return {
      items: page,
      nextCursor:
        more && last
          ? encode({ t: last.createdAt, id: last.wawuUserId })
          : null,
    };
  }

  private view(r: Row, entity: Entity): AdminWorldOpeningView {
    return {
      wawuUserId: r.wawuUserId,
      country: r.worldCountry ?? '',
      firstCurrency:
        r.worldFirstCurrency && isFiatCode(r.worldFirstCurrency)
          ? r.worldFirstCurrency
          : null,
      stage: worldStageOf(r, entity),
      reviewStatus: entity?.status ?? null,
      frozenAt: r.worldFrozenAt?.toISOString() ?? null,
      frozenReason: r.worldFrozenReason,
      cancelledAt: r.worldCancelledAt?.toISOString() ?? null,
      accountOpenedAt: r.worldAccountOpenedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    };
  }

  async act(
    admin: AdminUserView,
    wawuUserId: string,
    action: 'freeze' | 'unfreeze' | 'cancel',
    reason: string,
  ): Promise<AdminWorldActView> {
    const out = await this.prisma.$transaction(async (tx) => {
      // One act at a time per person: parallel acts wait here, then read the state the first left, so each act that
      // changes something writes exactly one audit row and a repeat changes nothing.
      await tx.$queryRaw`SELECT 1 FROM "FintavaWalletOpening" WHERE "wawuUserId" = ${wawuUserId} FOR UPDATE`;
      const row = await tx.fintavaWalletOpening.findUnique({
        where: { wawuUserId },
        select: ROW_SELECT,
      });
      if (!row?.worldCountry) {
        throw new MoneyError('not_found', 'We could not find that person.');
      }
      const entity = await tx.nuvionEntity.findUnique({
        where: { wawuUserId },
        select: ENTITY_SELECT,
      });
      const before = worldStageOf(row, entity);
      const now = new Date();
      let accountsChanged = 0;
      if (action === 'freeze') {
        if (row.worldCancelledAt || row.worldFrozenAt) {
          return { before, after: before, changed: false, accountsChanged };
        }
        await tx.fintavaWalletOpening.update({
          where: { wawuUserId },
          data: { worldFrozenAt: now, worldFrozenReason: reason },
        });
        const frozen = await tx.fxAccount.updateMany({
          where: { wawuUserId, status: 'open' },
          data: {
            status: 'frozen',
            frozenAt: now,
            frozenReason: `${WORLD_FREEZE_PREFIX}${reason}`.slice(0, 300),
          },
        });
        accountsChanged = frozen.count;
      } else if (action === 'unfreeze') {
        if (!row.worldFrozenAt) {
          return { before, after: before, changed: false, accountsChanged };
        }
        await tx.fintavaWalletOpening.update({
          where: { wawuUserId },
          data: { worldFrozenAt: null, worldFrozenReason: null },
        });
        // Only the accounts this freeze froze; one an admin froze on its
        // own stays frozen.
        const open = await tx.fxAccount.updateMany({
          where: {
            wawuUserId,
            status: 'frozen',
            frozenReason: { startsWith: WORLD_FREEZE_PREFIX },
          },
          data: { status: 'open', frozenAt: null, frozenReason: null },
        });
        accountsChanged = open.count;
      } else {
        if (row.worldCancelledAt) {
          return { before, after: before, changed: false, accountsChanged };
        }
        if (row.worldAccountOpenedAt) {
          throw new MoneyError(
            'account_frozen',
            'This wallet is already open. Freeze it instead.',
          );
        }
        await tx.fintavaWalletOpening.update({
          where: { wawuUserId },
          data: {
            worldCancelledAt: now,
            state: 'stopped',
            failure: CANCELLED_BY_ADMIN,
            // The document's claim is let go with it.
            bvnHash: releasedBvnHash(wawuUserId, row.bvnHash),
          },
        });
      }
      const after = worldStageOf(
        {
          ...row,
          worldFrozenAt: action === 'freeze' ? now : null,
          worldFrozenReason: action === 'freeze' ? reason : null,
          worldCancelledAt: action === 'cancel' ? now : row.worldCancelledAt,
        },
        entity,
      );
      await tx.worldAdminAudit.create({
        data: {
          subjectWawuId: wawuUserId,
          action,
          reason,
          stageBefore: before,
          stageAfter: after,
          actedByAdminId: admin.id,
          actedByAdminEmail: admin.email,
          actedByAdminRole: admin.role,
        },
      });
      return { before, after, changed: true, accountsChanged };
    });
    this.logger.log(`world wallet: ${action} by admin ${admin.id}`);
    return {
      wawuUserId,
      action,
      changed: out.changed,
      stageBefore: out.before,
      stageAfter: out.after,
      accountsChanged: out.accountsChanged,
    };
  }
}
