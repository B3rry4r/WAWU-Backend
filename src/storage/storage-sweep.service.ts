import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { StorageService } from './storage.service';

/**
 * Runs the late-file sweep on a timer (ME-04 round 3). A file that landed
 * after its upload was released sits in the bucket uncounted until this finds
 * it, so it cannot wait for the person to come back and read their allowance.
 *
 * Idempotent and safe to repeat: each row is settled once and every write is
 * guarded (see late-file-sweep.ts). With no storage configured it does
 * nothing. Registered through the ScheduleModule AppModule already loads.
 */
@Injectable()
export class StorageSweepService {
  private readonly logger = new Logger(StorageSweepService.name);

  constructor(private readonly storage: StorageService) {}

  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'sweep-late-uploads' })
  async sweep(): Promise<void> {
    try {
      const { removed, left } = await this.storage.sweepLateFiles();
      if (removed > 0 || left > 0) {
        this.logger.log(
          `Late-file sweep: ${removed} removed, ${left} left for the next pass.`,
        );
      }
    } catch (err) {
      this.logger.warn(`Late-file sweep failed: ${String(err)}`);
    }
  }
}
