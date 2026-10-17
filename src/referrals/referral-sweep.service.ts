import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ReferralRewardService } from './referral-reward.service';

/**
 * The referral job (task REF-02). Every minute: rewards whose tier payment
 * was granted without the hook running are made, then the rewards whose hold
 * has ended are settled. Safe on any number of servers: a reward is settled
 * under the referrer's lock and only once.
 *
 * @Cron runs only where ScheduleModule.forRoot() is loaded (AppModule); a
 * spec calls `run` directly.
 */
@Injectable()
export class ReferralSweepService {
  private readonly logger = new Logger(ReferralSweepService.name);
  private running = false;

  constructor(private readonly rewards: ReferralRewardService) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'referral-rewards' })
  async run(now: Date = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const made = await this.rewards.catchUp(now);
      const { granted, cancelled, failed } = await this.rewards.release(now);
      if (made + granted + cancelled + failed > 0)
        this.logger.log(
          `referral rewards: ${made} made, ${granted} granted, ${cancelled} cancelled, ${failed} failed`,
        );
    } catch (e) {
      this.logger.error(
        `referral job failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      this.running = false;
    }
  }
}
