import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { rowsToAnonymise, rowsToDelete } from './account-data-map';
import { POINTS_PURGE_MODELS, purgePersonPoints } from '../points/points-purge';

/** What a bought content piece is called once its creator's account is gone. */
export const REMOVED_CONTENT_TITLE = 'Removed content';

/**
 * Rows that must outlive their owner's delete because another table points at
 * them with `onDelete: Restrict`: only the unreferenced ones are deleted, the
 * rest are handled on purpose (`anonymiseSoldContent`). A Purchase is what a
 * buyer paid for (schema: Purchase.content).
 */
const KEPT_WHEN_REFERENCED: Record<string, Record<string, unknown>> = {
  ContentPiece: { purchases: { none: {} } },
};

/**
 * Removes one account's data from this database, everywhere it lives.
 *
 * The list of places comes from ACCOUNT_DATA_MAP, which a test holds against
 * the schema - see account-data-map.spec.ts. Nothing here hardcodes a table.
 */
@Injectable()
export class AccountPurgeService {
  private readonly logger = new Logger(AccountPurgeService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Deletes every row the account owns or authored. Returns what it removed,
   * per table, so the caller can log a real figure rather than "done".
   *
   * Not wrapped in one transaction on purpose. A purge across ~45 tables held
   * open as a single transaction takes locks across most of the database; if
   * it fails halfway the account is left partly deleted either way, and a
   * partial purge that is retryable beats a purge that cannot run at all
   * while the site is busy. Each deleteMany is idempotent, so retrying is
   * safe and the second run simply finds nothing.
   *
   * `pointsLeft` is true when the points step failed and every points row
   * of the person is still there (POINTS-01 round 3): the caller retries.
   *
   * `failed` names every table (`Model.column`) that could not be cleared, so
   * a caller that must not say "deleted" until it is true (SETTINGS-06's
   * sweep) can tell a full purge from one that swallowed an error. Empty: all
   * of it went. `keptForBuyers` counts content pieces a buyer paid for: a
   * Purchase restricts their deletion (a financial record), so they are
   * hidden and stripped of the person's words instead and the purge counts
   * that as done.
   */
  async purge(wawuUserId: string): Promise<{
    deleted: Record<string, number>;
    total: number;
    pointsLeft: boolean;
    failed: string[];
    keptForBuyers: number;
  }> {
    const deleted: Record<string, number> = {};
    const failed: string[] = [];
    let total = 0;
    let pointsLeft = false;

    // Points (POINTS-01) go in their own transaction under the person's
    // points lock: the ledger is append-only and its delete trigger accepts
    // only this step. The loop below then leaves those three tables alone.
    const pointsModels: ReadonlySet<string> = new Set(POINTS_PURGE_MODELS);
    try {
      const points = await purgePersonPoints(this.prisma, wawuUserId);
      for (const model of POINTS_PURGE_MODELS) {
        if (points[model] > 0) {
          deleted[`${model}.wawuUserId`] = points[model];
          total += points[model];
        }
      }
    } catch (e) {
      pointsLeft = true;
      this.logger.error(
        `Purge failed on points for ${wawuUserId}: ${(e as Error).message}`,
      );
    }

    for (const rule of rowsToDelete()) {
      if (pointsModels.has(rule.model)) continue;
      const delegateName =
        rule.model.charAt(0).toLowerCase() + rule.model.slice(1);
      const delegate = (
        this.prisma as unknown as Record<
          string,
          { deleteMany?: (a: unknown) => Promise<{ count: number }> }
        >
      )[delegateName];
      if (!delegate?.deleteMany) {
        // The drift test makes this unreachable in a healthy build; if it
        // ever fires, a table is being skipped and that must be loud.
        this.logger.error(
          `No Prisma delegate for ${rule.model} — data may be left behind for ${wawuUserId}`,
        );
        failed.push(`${rule.model}.${rule.column}`);
        continue;
      }
      try {
        const { count } = await delegate.deleteMany({
          where: {
            [rule.column]: wawuUserId,
            ...(KEPT_WHEN_REFERENCED[rule.model] ?? {}),
          },
        });
        if (count > 0) {
          deleted[`${rule.model}.${rule.column}`] = count;
          total += count;
        }
      } catch (e) {
        // Never let one table stop the rest. A row that will not delete is a
        // reason to keep going and report it, not to leave the other forty
        // tables untouched.
        this.logger.error(
          `Purge failed on ${rule.model}.${rule.column} for ${wawuUserId}: ${(e as Error).message}`,
        );
        failed.push(`${rule.model}.${rule.column}`);
      }
    }

    // Content a buyer paid for could not be deleted above (Purchase.content
    // is Restrict). It goes dark and loses everything that names the person.
    let keptForBuyers = 0;
    try {
      keptForBuyers = await this.anonymiseSoldContent(wawuUserId);
    } catch (e) {
      this.logger.error(
        `Purge failed on ContentPiece (bought) for ${wawuUserId}: ${(e as Error).message}`,
      );
      failed.push('ContentPiece.creatorWawuId');
    }

    // Rows kept because they carry somebody else's money: the account's
    // side is set to null instead (ACCOUNT_DATA_MAP, ANONYMISED).
    for (const rule of rowsToAnonymise()) {
      const delegateName =
        rule.model.charAt(0).toLowerCase() + rule.model.slice(1);
      const delegate = (
        this.prisma as unknown as Record<
          string,
          { updateMany?: (a: unknown) => Promise<{ count: number }> }
        >
      )[delegateName];
      if (!delegate?.updateMany) {
        this.logger.error(
          `No Prisma delegate for ${rule.model}: data may be left behind for ${wawuUserId}`,
        );
        failed.push(`${rule.model}.${rule.column}`);
        continue;
      }
      try {
        const data: Record<string, null> = { [rule.column]: null };
        for (const c of rule.clear ?? []) data[c] = null;
        const { count } = await delegate.updateMany({
          where: { [rule.column]: wawuUserId },
          data,
        });
        if (count > 0) {
          deleted[`${rule.model}.${rule.column} (anonymised)`] = count;
          total += count;
        }
      } catch (e) {
        this.logger.error(
          `Purge failed on ${rule.model}.${rule.column} for ${wawuUserId}: ${(e as Error).message}`,
        );
        failed.push(`${rule.model}.${rule.column}`);
      }
    }

    this.logger.log(
      `Purged ${total} rows for ${wawuUserId}: ${JSON.stringify(deleted)}` +
        (keptForBuyers > 0
          ? `; ${keptForBuyers} bought content piece(s) kept hidden and anonymised`
          : '') +
        (pointsLeft
          ? '; points were left (the points step failed; purge again)'
          : '') +
        (failed.length > 0
          ? `; could not clear ${failed.join(', ')} (purge again)`
          : ''),
    );
    return { deleted, total, pointsLeft, failed, keptForBuyers };
  }

  /**
   * The person's content pieces that are still there after the delete above
   * and have a Purchase: kept, because a buyer's receipt points at them. Each
   * is hidden (`removed`) and loses its title, description, preview, files,
   * tags and slug, and its lessons, frames and preview settings go, so
   * nothing a reader could see names the person. Idempotent.
   */
  private async anonymiseSoldContent(wawuUserId: string): Promise<number> {
    const sold = await this.prisma.contentPiece.findMany({
      where: { creatorWawuId: wawuUserId, purchases: { some: {} } },
      select: { id: true },
    });
    if (sold.length === 0) return 0;
    const ids = sold.map((p) => p.id);
    await this.prisma.$transaction([
      this.prisma.courseLesson.deleteMany({
        where: { contentId: { in: ids } },
      }),
      this.prisma.contentFrame.deleteMany({
        where: { contentId: { in: ids } },
      }),
      this.prisma.contentDetail.deleteMany({
        where: { contentId: { in: ids } },
      }),
      ...ids.map((id) =>
        this.prisma.contentPiece.update({
          where: { id },
          data: {
            status: 'removed',
            title: REMOVED_CONTENT_TITLE,
            description: '',
            slug: `removed-${id}`,
            previewAssetUrl: '',
            fullAssetUrl: null,
            durationLabel: null,
            pageCount: null,
            tags: [],
            specializations: [],
          },
        }),
      ),
    ]);
    return ids.length;
  }
}
