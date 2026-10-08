import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PointsService } from './points.service';

/**
 * The points expiry job (task POINTS-01). Every five minutes, each lot that
 * has ended with points still in it loses them, one `expire` ledger row per
 * lot (PointsService.expireLapsed, at most POINTS_EXPIRY.batch lots a pass).
 *
 * What a person sees never waits for it: a balance, a hold and `GET
 * /me/points` count only lots that have not ended. The job writes the ledger
 * row that says the points left, so the movement list shows "Expired" within
 * one pass of the end.
 *
 * @Cron runs only where ScheduleModule.forRoot() is loaded (AppModule); a
 * spec that builds its own module calls `run` directly.
 */
@Injectable()
export class PointsExpiryService {
  private readonly logger = new Logger(PointsExpiryService.name);
  private running = false;

  constructor(private readonly points: PointsService) {}

  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'points-expiry' })
  async run(now: Date = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const { lots, points, failed } = await this.points.expireLapsed(now);
      if (lots > 0 || failed > 0) {
        this.logger.log(
          `points expiry: ${lots} lots ended, ${points} points left them, ${failed} refused`,
        );
      }
    } catch (e) {
      // The name only; the next pass picks up whatever this one did not.
      this.logger.error(
        `points expiry: a pass failed (${(e as Error).name ?? 'Error'})`,
      );
    } finally {
      this.running = false;
    }
  }
}
