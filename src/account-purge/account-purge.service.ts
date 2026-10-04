import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { rowsToAnonymise, rowsToDelete } from './account-data-map';

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
   */
  async purge(
    wawuUserId: string,
  ): Promise<{ deleted: Record<string, number>; total: number }> {
    const deleted: Record<string, number> = {};
    let total = 0;

    for (const rule of rowsToDelete()) {
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
        continue;
      }
      try {
        const { count } = await delegate.deleteMany({
          where: { [rule.column]: wawuUserId },
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
      }
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
      }
    }

    this.logger.log(
      `Purged ${total} rows for ${wawuUserId}: ${JSON.stringify(deleted)}`,
    );
    return { deleted, total };
  }
}
