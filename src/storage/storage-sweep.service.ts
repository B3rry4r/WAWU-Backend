import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { StorageService } from './storage.service';

/**
 * Runs the late-file sweep on a timer (ME-04 round 3). A file that landed
 * after its upload was released sits in the bucket uncounted until this finds
 * it, so it cannot wait for the person to come back and read their allowance.
 *
 * Idempotent and safe to repeat: each file is settled once under its person's
 * lock and every write is guarded (see late-file-sweep.ts). With no storage configured it does
 * nothing. Registered through the ScheduleModule AppModule already loads.
 */
/** The unsent-chat-file sweep runs at most this often (the timer itself ticks every 10 minutes). */
const UNSENT_CHAT_SWEEP_EVERY_MS = 60 * 60 * 1000;

@Injectable()
export class StorageSweepService {
  private readonly logger = new Logger(StorageSweepService.name);

  /** A run is under way: the next tick skips (ME-04 round 5). */
  private running = false;

  /** When the chat sweep last ran: it looks at every unsent chat file, so once an hour is plenty. */
  private lastUnsentChatSweep = 0;

  constructor(private readonly storage: StorageService) {}

  /**
   * One run at a time. A run that is slow (a bucket that answers late, many
   * rows) must not be joined by the next tick: each run holds database
   * connections while it works, and two together only wait on each other's
   * rows. A tick that finds the last run still going skips and says so once.
   */
  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'sweep-late-uploads' })
  async sweep(): Promise<void> {
    if (this.running) {
      this.logger.warn(
        'Late-file sweep skipped: the previous run is still going.',
      );
      return;
    }
    this.running = true;
    try {
      const { removed, counted, left } = await this.storage.sweepLateFiles();
      if (removed > 0 || counted > 0 || left > 0) {
        this.logger.log(
          `Late-file sweep: ${removed} removed, ${counted} counted, ${left} left for the next pass.`,
        );
      }
      // FIX-104 round 2: chat files that landed and no message carries, a day on.
      if (Date.now() - this.lastUnsentChatSweep >= UNSENT_CHAT_SWEEP_EVERY_MS) {
        this.lastUnsentChatSweep = Date.now();
        const gone = await this.storage.sweepUnsentChatUploads();
        if (gone.released > 0 || gone.left > 0) {
          this.logger.log(
            `Unsent chat files: ${gone.released} given back, ${gone.left} left for the next run.`,
          );
        }
      }
    } catch (err) {
      this.logger.warn(`Late-file sweep failed: ${String(err)}`);
    } finally {
      this.running = false;
    }
  }
}
