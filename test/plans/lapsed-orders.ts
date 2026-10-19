import type { PrismaService } from '../../src/common/prisma/prisma.service';
import { ORDER_STATUS } from '../../src/plans/purchases/plan-transfer-order';
import type {
  PlanTransferService,
  TransferSweepReport,
} from '../../src/plans/purchases/plan-transfer.service';

/**
 * Runs the transfer sweep at `at` and counts only what it did to the orders
 * that were due then.
 *
 * The sweep expires EVERY lapsed waiting order in the database, and the deploy
 * runs every spec in one process on one database, so waiting orders that other
 * specs left behind lapse with the spec's own. Read who is due before the
 * sweep, then count only those: `report.expired` must equal the due orders that
 * are now expired, and a spec asserts that its own order is the one it
 * expired. On an empty database that is the plain count of 1.
 */
export async function sweepWithDue(
  prisma: PrismaService,
  transfers: PlanTransferService,
  at: Date,
): Promise<{
  /** The ids of the orders waiting and lapsed at `at`, before the sweep. */
  due: string[];
  report: TransferSweepReport;
  /** How many of the due orders are `expired` now, optionally of one person. */
  expiredAmongDue: (over?: { wawuUserId?: string }) => Promise<number>;
}> {
  const due = (
    await prisma.planTransferOrder.findMany({
      where: { status: ORDER_STATUS.awaiting, expiresAt: { lte: at } },
      select: { id: true },
    })
  ).map((o) => o.id);
  const report = await transfers.sweep(at);
  const expiredAmongDue = (over: { wawuUserId?: string } = {}) =>
    prisma.planTransferOrder.count({
      where: { id: { in: due }, status: ORDER_STATUS.expired, ...over },
    });
  return { due, report, expiredAmongDue };
}
