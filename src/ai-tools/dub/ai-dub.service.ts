import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import { AiJobService } from '../ai-job.service';
import { DUBBING_ACTION, DUBBING_MAX_RUN_SETTING } from '../tools/dubbing.tool';
import {
  AI_VOICE_PROVIDER,
  AiVoiceProviderError,
  type AiVoiceProvider,
  type DubOutputs,
  type ProviderCopy,
} from '../voice/ai-voice-provider';
import { copyOfFollow, parseFollowRef, type FollowRef } from './dub-support';
import type { AiToolJob } from '../../../generated/prisma/client';

/** Dubbing jobs read at once in a pass, and the most a pass takes up. */
const READ_AT_ONCE = 4;
const PASS_BATCH = 100;
/** Tries at fetching a finished dub's links (each on a later pass, with fresh links) before the job gives up. */
export const OUTPUT_TRIES = 3;
/**
 * The most a dub's audio may be, per priced minute of the file: a lossless FLAC
 * of speech is a few MB a minute, so 20 MB a minute leaves room; the least
 * 32 MB and the most 400 MB keep one fetch bounded. Fetches run one at a time.
 */
const AUDIO_BYTES_PER_MINUTE = 20 * 1024 * 1024;
const AUDIO_BYTES_FLOOR = 32 * 1024 * 1024;
const AUDIO_BYTES_CEILING = 400 * 1024 * 1024;

export function audioCapFor(minutes: number): number {
  return Math.min(
    AUDIO_BYTES_CEILING,
    Math.max(AUDIO_BYTES_FLOOR, Math.max(1, minutes) * AUDIO_BYTES_PER_MINUTE),
  );
}

export interface DubPass {
  /** Jobs read this pass. */
  read: number;
  done: number;
  failed: number;
  /** Jobs still working. */
  waiting: number;
}

/**
 * FOLLOWS THE DUBS (AITOOLS-05). A dub is the one slow tool: `startDub` hands
 * the provider the file and the job stays `working` with the provider's project
 * and language ids on its row (`providerRef`). Every few seconds this reads each
 * working dub's language target (no transaction, connection or lock held across
 * a read) and moves it on:
 *
 *   queued, processing   still working;
 *   completed            fetch the signed links ONCE (they last an hour), store
 *                        the audio and subtitles, COMMIT, mark done, delete the project;
 *   failed, stale        RELEASE, mark failed, delete the project;
 *   past the dub's own   RELEASE, mark failed, delete the project
 *   longest run          (`ai.dubbing_max_run_minutes`).
 *
 * All the state is in the database, so a Hub that restarts mid-dub picks every
 * working dub up again on its next pass. Polling, not the provider's webhook: a
 * webhook needs a public address and a setup on the provider's side. A read of
 * the job does not call the provider; it only follows the hold (`reconcile`).
 * Provider answers go to the log as a status number only, never to a person.
 * One pass at a time; the output fetches run one at a time so the Hub holds at
 * most one dubbed file in memory.
 *
 * @Cron runs only where ScheduleModule.forRoot() is loaded (AppModule); a spec
 * calls `pass` directly.
 */
@Injectable()
export class AiDubService {
  private readonly logger = new Logger(AiDubService.name);
  private passing = false;
  /** Failed fetches of a finished dub's outputs by job id (a restart only gives more tries; the dub's longest run still ends it). */
  private readonly fetchTries = new Map<string, number>();
  private fetching: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: PlanSettingsService,
    @Inject(AI_VOICE_PROVIDER) private readonly voice: AiVoiceProvider,
    private readonly jobs: AiJobService,
  ) {}

  @Cron('*/15 * * * * *', { name: 'ai-dub-follow' })
  async tick(): Promise<void> {
    try {
      await this.pass();
    } catch (e) {
      this.logger.error(
        `dub follower: a pass failed (${(e as Error).name ?? 'Error'})`,
      );
    }
  }

  /** One pass over the working dubs. Never throws for one job's trouble; a pass already running makes this one a no-op. */
  async pass(now: Date = new Date()): Promise<DubPass> {
    const out: DubPass = { read: 0, done: 0, failed: 0, waiting: 0 };
    if (this.passing) return out;
    this.passing = true;
    try {
      const rows = await this.prisma.aiToolJob.findMany({
        where: { tool: DUBBING_ACTION, state: 'working' },
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
              `ai job ${row.id} (dubbing): a pass could not follow it (${(e as Error).name ?? 'Error'})`,
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

  /** One working dub: where it stands, and what that means for the job. */
  private async follow(
    seen: AiToolJob,
    now: Date,
  ): Promise<'done' | 'failed' | 'waiting'> {
    // A hold the sweep gave back, or a commit a dead run left, ends the job here.
    const job = await this.jobs.reconcile(seen);
    if (job.state !== 'working')
      return job.state === 'done' ? 'done' : 'failed';
    const ref = parseFollowRef(job.providerRef);
    const copy: ProviderCopy | null = ref ? copyOfFollow(ref) : null;

    const limitMs = this.settings.number(DUBBING_MAX_RUN_SETTING) * 60_000;
    if (now.getTime() - job.createdAt.getTime() > limitMs) {
      this.logger.warn(
        `ai job ${job.id} (dubbing): still working past its longest run`,
      );
      await this.jobs.failFollowed(job.id, 'timed_out', copy);
      return 'failed';
    }
    // The provider has not been asked yet (the request is still starting) or
    // the Hub died before it kept the ids: the longest run ends it.
    if (!ref) return 'waiting';

    let progress;
    try {
      progress = await this.voice.readDub(ref.projectId, ref.languageId);
    } catch (e) {
      const status = e instanceof AiVoiceProviderError ? e.status : undefined;
      this.logger.warn(
        `ai job ${job.id} (dubbing): reading the dub, the provider ${
          status !== undefined ? `answered ${status}` : 'did not answer'
        }`,
      );
      // The project or the language is gone at the provider: nothing to wait for.
      if (status === 404 || status === 410) {
        await this.jobs.failFollowed(job.id, 'provider_failed', copy);
        return 'failed';
      }
      return 'waiting';
    }

    switch (progress.status) {
      case 'queued':
      case 'processing':
        return 'waiting';
      case 'failed':
      case 'stale':
        this.logger.warn(
          `ai job ${job.id} (dubbing): the provider ended the dub (${progress.status})`,
        );
        await this.jobs.failFollowed(job.id, 'provider_failed', copy);
        return 'failed';
      case 'completed':
        return this.complete(
          job,
          ref,
          progress.audioUrl,
          progress.subtitlesUrl,
        );
    }
  }

  /** The dub is ready: fetch the signed outputs once, then finish the job. */
  private async complete(
    job: AiToolJob,
    ref: FollowRef,
    audioUrl: string | null,
    subtitlesUrl: string | null,
  ): Promise<'done' | 'failed' | 'waiting'> {
    const copy = copyOfFollow(ref);
    if (!audioUrl) {
      this.logger.warn(`ai job ${job.id} (dubbing): completed with no audio`);
      await this.jobs.failFollowed(job.id, 'output_missing', copy);
      return 'failed';
    }
    let outputs: DubOutputs;
    try {
      outputs = await this.oneAtATime(() =>
        this.voice.fetchDubOutputs(
          { audioUrl, subtitlesUrl },
          { maxAudioBytes: audioCapFor(job.units) },
        ),
      );
    } catch (e) {
      const status = e instanceof AiVoiceProviderError ? e.status : undefined;
      const tries = (this.fetchTries.get(job.id) ?? 0) + 1;
      this.logger.warn(
        `ai job ${job.id} (dubbing): the finished dub could not be fetched (try ${tries}${
          status !== undefined ? `, the provider's host answered ${status}` : ''
        })`,
      );
      if (tries < OUTPUT_TRIES) {
        this.fetchTries.set(job.id, tries);
        return 'waiting'; // the next pass reads fresh links
      }
      this.fetchTries.delete(job.id);
      await this.jobs.failFollowed(job.id, 'output_fetch_failed', copy);
      return 'failed';
    }
    this.fetchTries.delete(job.id);
    await this.jobs.completeFollowed(job.id, {
      audio: { audio: outputs.audio, contentType: outputs.contentType },
      texts: outputs.subtitles
        ? [{ kind: 'subtitles', text: outputs.subtitles }]
        : [],
      endCopy: copy,
    });
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

  /** Runs `work` after the one before it, so the Hub holds one dubbed file at a time. */
  private oneAtATime<T>(work: () => Promise<T>): Promise<T> {
    const run = this.fetching.then(work, work);
    this.fetching = run.catch(() => undefined);
    return run;
  }
}
