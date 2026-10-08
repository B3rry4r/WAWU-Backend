import type { PrismaService } from '../common/prisma/prisma.service';
import { lockPersonPoints } from './points-lock';

/** The tables this step empties for one person, in the order it deletes them. */
export const POINTS_PURGE_MODELS = [
  'PointLedger',
  'PointHold',
  'PointLot',
] as const;

export interface PointsPurgeCounts {
  PointLedger: number;
  PointHold: number;
  PointLot: number;
}

/**
 * Account deletion's points step (task POINTS-01, round 2). One transaction:
 * the person's points lock first, so no grant, hold, release or expiry of
 * theirs runs alongside; then `wawu.points_purge` set to their id for this
 * transaction only (`set_config(..., true)`), the one thing the ledger's
 * delete trigger accepts; then their ledger rows (all of them, in one
 * statement, which the trigger also requires), their holds and their lots.
 * Either all of it goes or none of it does. Running it again finds nothing.
 */
export async function purgePersonPoints(
  prisma: PrismaService,
  wawuUserId: string,
): Promise<PointsPurgeCounts> {
  return prisma.$transaction(async (tx) => {
    await lockPersonPoints(tx, wawuUserId);
    await tx.$executeRaw`SELECT set_config('wawu.points_purge', ${wawuUserId}, true)`;
    const ledger = await tx.pointLedger.deleteMany({ where: { wawuUserId } });
    const holds = await tx.pointHold.deleteMany({ where: { wawuUserId } });
    const lots = await tx.pointLot.deleteMany({ where: { wawuUserId } });
    return {
      PointLedger: ledger.count,
      PointHold: holds.count,
      PointLot: lots.count,
    };
  });
}
