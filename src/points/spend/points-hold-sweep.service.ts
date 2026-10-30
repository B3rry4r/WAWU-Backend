import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import { PointsSpendService } from './points-spend.service';

/** The setting: the longest an AI job may run before its held points are given back. */
export const JOB_MAX_RUN_SETTING = 'points.job_max_run_minutes';
/**
 * Dubbing is the one slow tool (AITOOLS-05): the provider works on a dub for
 * minutes, so its hold has its OWN longest run, a setting, and the sweep leaves a
 * dub's hold alone until then. The action is the Dubbing job's `tool`.
 */
export const DUB_MAX_RUN_SETTING = 'ai.dubbing_max_run_minutes';
export const DUB_ACTION_ID = 'dub_standard_per_min_lang';
/**
 * R-109 (AITOOLS-13, AITOOLS-06): an Audiobook (many chapters in turn), a Podcast (the provider works for minutes) and a
 * talking session with a Receptionist (held for its longest, settled when it ends) run longer than the other tools,
 * so each has its OWN longest run, a setting; the sweep leaves their holds alone until then.
 */
export const AUDIOBOOK_RUN_SETTING = 'ai.audiobook_max_run_minutes';
export const AUDIOBOOK_ACTION_ID = 'audiobook_per_min';
export const PODCAST_RUN_SETTING = 'ai.podcast_max_run_seconds';
export const PODCAST_ACTION_IDS = [
  'podcast_short',
  'podcast_standard',
  'podcast_long',
] as const;
export const RECEPTIONIST_VOICE_ACTION_ID = 'receptionist_voice_per_min';
export const RECEPTIONIST_VOICE_MAX_SETTING =
  'ai.receptionist_voice_max_minutes';
/** Minutes past the longest talking session after which the Hub settles a session nobody ended, at the longest. */
export const RECEPTIONIST_VOICE_GRACE_MINUTES = 15;

/**
 * The sweep for stale AI holds (task POINTS-03, lead note of 8 Oct). Every
 * five minutes, each `ai_job` hold still `held` after the longest a job may
 * run (an admin setting) is given back, by its id, so a job whose server died
 * never keeps a person's points. A job that commits late and the sweep cannot
 * both win: the second is refused (`points_hold_settled`) and skipped.
 *
 * @Cron runs only where ScheduleModule.forRoot() is loaded (AppModule); a spec
 * that builds its own module calls `run` directly.
 */
@Injectable()
export class PointsHoldSweepService {
  private readonly logger = new Logger(PointsHoldSweepService.name);
  private running = false;

  constructor(
    private readonly spend: PointsSpendService,
    private readonly settings: PlanSettingsService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'points-hold-sweep' })
  async run(now: Date = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const { released, failed } = await this.spend.releaseStale(
        this.settings.number(JOB_MAX_RUN_SETTING),
        now,
        undefined,
        [
          {
            action: DUB_ACTION_ID,
            maxRunMinutes: this.settings.number(DUB_MAX_RUN_SETTING),
          },
          {
            action: AUDIOBOOK_ACTION_ID,
            maxRunMinutes: this.settings.number(AUDIOBOOK_RUN_SETTING),
          },
          ...PODCAST_ACTION_IDS.map((action) => ({
            action,
            maxRunMinutes: Math.ceil(
              this.settings.number(PODCAST_RUN_SETTING) / 60,
            ),
          })),
          {
            action: RECEPTIONIST_VOICE_ACTION_ID,
            maxRunMinutes:
              this.settings.number(RECEPTIONIST_VOICE_MAX_SETTING) +
              RECEPTIONIST_VOICE_GRACE_MINUTES,
          },
        ],
      );
      if (released > 0 || failed > 0) {
        this.logger.log(
          `points sweep: ${released} stale AI holds given back, ${failed} refused`,
        );
      }
    } catch (e) {
      this.logger.error(
        `points sweep: a pass failed (${(e as Error).name ?? 'Error'})`,
      );
    } finally {
      this.running = false;
    }
  }
}
