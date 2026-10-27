import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { StoreIntentService } from './store-intent.service';

/** Once a day, deletes the intents that were never used, 7 days after they ran out (STORE-BUY-HUB round 3). */
@Injectable()
export class StoreIntentSweepService {
  private readonly logger = new Logger(StoreIntentSweepService.name);

  constructor(private readonly intents: StoreIntentService) {}

  @Cron(CronExpression.EVERY_DAY_AT_4AM, { name: 'store-intent-sweep' })
  async sweep(now = new Date()): Promise<number> {
    try {
      const deleted = await this.intents.sweepUnused(now);
      if (deleted > 0)
        this.logger.log(`store intents: ${deleted} unused ones deleted`);
      return deleted;
    } catch (e) {
      this.logger.error(
        `store intent sweep failed (${e instanceof Error ? e.name : 'error'})`,
      );
      return 0;
    }
  }
}
