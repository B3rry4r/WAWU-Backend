import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { AiToolJob } from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import { AiJobService } from '../ai-job.service';
import {
  PODCAST_ACTIONS,
  PODCAST_MAX_RUN_SETTING,
} from '../tools/podcast.tool';
import {
  AI_VOICE_PROVIDER,
  AiVoiceProviderError,
  type AiVoiceProvider,
} from '../voice/ai-voice-provider';
import { copyOfCast, parseCastRef } from './podcast-support';

/** The plan actions of the tool this follower follows. */
export const PODCAST_FOLLOW_ACTIONS = Object.values(PODCAST_ACTIONS);
const READ_AT_ONCE = 4;
const PASS_BATCH = 100;
/** How often a project is read (5 seconds). */
export const PODCAST_POLL_MS = 5_000;
/** Tries at fetching a finished podcast's audio (each on a later pass) before the job gives up. */
export const PODCAST_FETCH_TRIES = 3;

export interface PodcastPass {
  read: number;
  done: number;
  failed: number;
  waiting: number;
}

/**
 * FOLLOWS THE PODCASTS (AITOOLS-13, R-109). `startPodcast` answers at once with the provider's project and the job stays
 * `working` with that id on its row (`castrun:<id>`). Every few seconds this reads each working project (no
 * transaction, connection or lock held across a read):
 *
 *   not ready yet        still working;
 *   ready                list its snapshots, take the audio, store it, COMMIT, mark done, delete the project;
 *   past the longest run RELEASE, mark failed, delete the project (`ai.podcast_max_run_seconds`).
 *
 * All the state is in the database, so a Hub that restarts mid-run picks every working podcast up on its next pass.
 * The project is the provider's copy and is deleted however the job ends, so it keeps nothing of the person's words.
 *
 * @Cron runs only where ScheduleModule.forRoot() is loaded (AppModule); a spec calls `pass` directly.
 */
@Injectable()
export class AiPodcastService {
  private readonly logger = new Logger(AiPodcastService.name);
  private passing = false;
  private readonly fetchTries = new Map<string, number>();
  private readonly lastRead = new Map<string, number>();
  /** How often a project is read; a spec shortens it. */
  pollMs = PODCAST_POLL_MS;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: PlanSettingsService,
    @Inject(AI_VOICE_PROVIDER) private readonly voice: AiVoiceProvider,
    private readonly jobs: AiJobService,
  ) {}

  @Cron('*/3 * * * * *', { name: 'ai-podcast-follow' })
  async tick(): Promise<void> {
    try {
      await this.pass();
    } catch (e) {
      this.logger.error(
        `podcast follower: a pass failed (${(e as Error).name ?? 'Error'})`,
      );
    }
  }

  async pass(now: Date = new Date()): Promise<PodcastPass> {
    const out: PodcastPass = { read: 0, done: 0, failed: 0, waiting: 0 };
    if (this.passing) return out;
    this.passing = true;
    try {
      const rows = await this.prisma.aiToolJob.findMany({
        where: { tool: { in: PODCAST_FOLLOW_ACTIONS }, state: 'working' },
        orderBy: { createdAt: 'asc' },
        take: PASS_BATCH,
      });
      let next = 0;
      const worker = async () => {
        for (;;) {
          const row = rows[next++];
          if (!row) return;
          out.read += 1;
          const outcome = await this.follow(row, now).catch((e: unknown) => {
            this.logger.warn(
              `ai job ${row.id} (podcast): a pass could not follow it (${(e as Error).name ?? 'Error'})`,
            );
            return 'waiting' as const;
          });
          out[outcome] += 1;
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(READ_AT_ONCE, rows.length) }, worker),
      );
    } finally {
      this.passing = false;
    }
    return out;
  }

  private async follow(
    seen: AiToolJob,
    now: Date,
  ): Promise<'done' | 'failed' | 'waiting'> {
    // The row as it stands now: the first step may have noted the provider's project since the pass began, and a
    // project the row names is always deleted when the job ends.
    const fresh =
      (await this.prisma.aiToolJob.findUnique({ where: { id: seen.id } })) ??
      seen;
    const job = await this.jobs.reconcile(fresh);
    if (job.state !== 'working') {
      this.lastRead.delete(job.id);
      return job.state === 'done' ? 'done' : 'failed';
    }
    const projectId = parseCastRef(job.providerRef);
    const copy = projectId ? copyOfCast(projectId) : null;
    const limitMs = this.settings.number(PODCAST_MAX_RUN_SETTING) * 1000;
    if (now.getTime() - job.createdAt.getTime() > limitMs) {
      this.logger.warn(
        `ai job ${job.id} (podcast): still working past its longest run`,
      );
      await this.jobs.failFollowed(job.id, 'timed_out', copy);
      this.lastRead.delete(job.id);
      return 'failed';
    }
    // The provider has not been asked yet (the request is still starting) or the Hub died before it kept the id: the longest run ends it.
    if (!projectId || !copy) return 'waiting';
    const last = this.lastRead.get(job.id);
    if (last !== undefined && now.getTime() - last < this.pollMs - 500)
      return 'waiting';
    this.lastRead.set(job.id, now.getTime());

    try {
      const progress = await this.voice.readPodcast(projectId);
      if (!progress.ready) return 'waiting';
    } catch (e) {
      const status = e instanceof AiVoiceProviderError ? e.status : undefined;
      this.logger.warn(
        `ai job ${job.id} (podcast): reading the project, the provider ${status !== undefined ? `answered ${status}` : 'did not answer'}`,
      );
      // The project is gone at the provider: nothing to wait for.
      if (status === 404 || status === 410) {
        await this.jobs.failFollowed(job.id, 'provider_failed', copy);
        this.lastRead.delete(job.id);
        return 'failed';
      }
      return 'waiting';
    }

    let audio;
    try {
      audio = await this.voice.fetchPodcastAudio(projectId);
    } catch (e) {
      const status = e instanceof AiVoiceProviderError ? e.status : undefined;
      const tries = (this.fetchTries.get(job.id) ?? 0) + 1;
      this.logger.warn(
        `ai job ${job.id} (podcast): the finished audio could not be fetched (try ${tries}${status !== undefined ? `, the provider answered ${status}` : ''})`,
      );
      if (tries < PODCAST_FETCH_TRIES) {
        this.fetchTries.set(job.id, tries);
        this.lastRead.delete(job.id);
        return 'waiting';
      }
      this.fetchTries.delete(job.id);
      await this.jobs.failFollowed(job.id, 'output_fetch_failed', copy);
      return 'failed';
    }
    this.fetchTries.delete(job.id);
    this.lastRead.delete(job.id);
    await this.jobs.completeFollowed(job.id, { audio, endCopy: copy });
    const after = await this.prisma.aiToolJob.findUnique({
      where: { id: job.id },
      select: { state: true },
    });
    return after?.state === 'done'
      ? 'done'
      : after?.state === 'failed'
        ? 'failed'
        : 'waiting';
  }
}
