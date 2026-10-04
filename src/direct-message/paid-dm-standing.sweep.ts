import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PaidDmPauseService } from './paid-dm-pause.service';

/**
 * Warn and pause creators whose paid questions went unanswered (R-13), and
 * lift a pause that has ended. The standing is also evaluated whenever a fan
 * tries to send, so this sweep only makes the warning and the pause arrive
 * when a question lapses rather than when someone next looks.
 *
 * Idempotent: a creator already in the state their numbers give is left as
 * they are, and a pause is never extended.
 */
@Injectable()
export class PaidDmStandingSweep {
  private readonly logger = new Logger(PaidDmStandingSweep.name);

  constructor(private readonly pause: PaidDmPauseService) {}

  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'paid-dm-standing' })
  async run(): Promise<void> {
    const count = await this.pause.sweep();
    if (count > 0) {
      this.logger.log(
        `Checked the paid-question standing of ${count} creator(s).`,
      );
    }
  }
}
