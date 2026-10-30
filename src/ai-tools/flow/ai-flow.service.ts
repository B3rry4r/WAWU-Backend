import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import { AiJobService } from '../ai-job.service';
import {
  AI_IMAGE_CONTENT_TYPES,
  AI_MEDIA_MAX_BYTES,
  AI_VIDEO_CONTENT_TYPES,
} from '../media/ai-media-store';
import { toolForAction } from '../tools';
import { IMAGE_ACTION, IMAGE_MAX_RUN_SETTING } from '../tools/image.tool';
import { PHOTO_EDIT_ACTION } from '../tools/photo-edit.tool';
import { TALKING_PHOTO_ACTION } from '../tools/talking-photo.tool';
import { VIDEO_ACTION, VIDEO_MAX_RUN_SETTING } from '../tools/video.tool';
import {
  AI_VOICE_PROVIDER,
  AiVoiceProviderError,
  type AiVoiceProvider,
  type GenerationProgress,
  type ProviderCopy,
} from '../voice/ai-voice-provider';
import { copyOfFlow, parseFlowRef, type FlowRef } from './flow-support';
import type { AiToolJob } from '../../../generated/prisma/client';

/** The plan actions of the tools this follower follows. */
export const FLOW_ACTIONS = [
  IMAGE_ACTION,
  PHOTO_EDIT_ACTION,
  VIDEO_ACTION,
  TALKING_PHOTO_ACTION,
] as const;

/** Jobs read at once in a pass, and the most a pass takes up. */
const READ_AT_ONCE = 4;
const PASS_BATCH = 100;
/** How often a picture is read (3 seconds) and how often a video is (5). */
export const IMAGE_POLL_MS = 3_000;
export const VIDEO_POLL_MS = 5_000;
/** Tries at fetching a finished file (each on a later pass, with a fresh read of the link) before the job gives up. */
export const FLOW_OUTPUT_TRIES = 3;

export interface FlowPass {
  /** Jobs read this pass. */
  read: number;
  done: number;
  failed: number;
  /** Jobs still working. */
  waiting: number;
}

/**
 * FOLLOWS THE PICTURES AND VIDEOS (AITOOLS-09, AITOOLS-10, R-109). The
 * provider makes a picture or a clip in the background: `startImage` or
 * `startVideo` answers at once with an id and the job stays `working` with that
 * id (and the ids of the person's photo and voice it sent up) on its row
 * (`providerRef`, `genrun:...`). Every few seconds this reads each working
 * generation (no transaction, connection or lock held across a read) and moves
 * it on:
 *
 *   pending, generating  still working;
 *   completed            open the signed link ONCE (it lasts an hour), store the
 *                        file streamed, COMMIT, mark done, delete the assets;
 *   failed               RELEASE, mark failed (the content refusal in its own
 *                        words), delete the assets;
 *   past the tool's own  RELEASE, mark failed, delete the assets
 *   longest run          (`ai.image_max_run_seconds`, `ai.video_max_run_seconds`).
 *
 * All the state is in the database, so a Hub that restarts mid-run picks every
 * working generation up again on its next pass. Polling, not the provider's
 * webhook: a webhook needs a public address and a setup on the provider's side.
 * A read of the job does not call the provider; it only follows the hold
 * (`reconcile`). Provider answers go to the log as a status number only, never
 * to a person. One pass at a time.
 *
 * @Cron runs only where ScheduleModule.forRoot() is loaded (AppModule); a spec
 * calls `pass` directly.
 */
@Injectable()
export class AiFlowService {
  private readonly logger = new Logger(AiFlowService.name);
  private passing = false;
  /** Failed fetches of a finished file by job id (a restart only gives more tries; the longest run still ends it). */
  private readonly fetchTries = new Map<string, number>();
  /** When each job was last read, so a video is read every 5 seconds though the pass runs every 3. */
  private readonly lastRead = new Map<string, number>();
  /** How often a picture and a video are read; a spec shortens them. */
  pollMs: { image: number; video: number } = {
    image: IMAGE_POLL_MS,
    video: VIDEO_POLL_MS,
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: PlanSettingsService,
    @Inject(AI_VOICE_PROVIDER) private readonly voice: AiVoiceProvider,
    private readonly jobs: AiJobService,
  ) {}

  @Cron('*/3 * * * * *', { name: 'ai-flow-follow' })
  async tick(): Promise<void> {
    try {
      await this.pass();
    } catch (e) {
      this.logger.error(
        `picture and video follower: a pass failed (${(e as Error).name ?? 'Error'})`,
      );
    }
  }

  /** One pass over the working generations. Never throws for one job's trouble; a pass already running makes this one a no-op. */
  async pass(now: Date = new Date()): Promise<FlowPass> {
    const out: FlowPass = { read: 0, done: 0, failed: 0, waiting: 0 };
    if (this.passing) return out;
    this.passing = true;
    try {
      const rows = await this.prisma.aiToolJob.findMany({
        where: { tool: { in: [...FLOW_ACTIONS] }, state: 'working' },
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
              `ai job ${row.id} (${row.tool}): a pass could not follow it (${(e as Error).name ?? 'Error'})`,
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

  /** One working generation: where it stands, and what that means for the job. */
  private async follow(
    seen: AiToolJob,
    now: Date,
  ): Promise<'done' | 'failed' | 'waiting'> {
    // A hold the sweep gave back, or a commit a dead run left, ends the job here.
    const job = await this.jobs.reconcile(seen);
    if (job.state !== 'working') {
      this.lastRead.delete(job.id);
      return job.state === 'done' ? 'done' : 'failed';
    }
    const ref = parseFlowRef(job.providerRef);
    const copy: ProviderCopy | null = ref ? copyOfFlow(ref) : null;
    const tool = toolForAction(job.tool);
    const limitMs =
      this.settings.number(
        tool?.id === 'video' || tool?.id === 'talking-photo'
          ? VIDEO_MAX_RUN_SETTING
          : IMAGE_MAX_RUN_SETTING,
      ) * 1000;
    if (now.getTime() - job.createdAt.getTime() > limitMs) {
      this.logger.warn(
        `ai job ${job.id} (${job.tool}): still working past its longest run`,
      );
      await this.jobs.failFollowed(job.id, 'timed_out', copy);
      this.lastRead.delete(job.id);
      return 'failed';
    }
    // The provider has not been asked yet (the request is still starting) or
    // the Hub died before it kept the ids: the longest run ends it.
    if (!ref) return 'waiting';

    const every = this.pollMs[ref.kind];
    const last = this.lastRead.get(job.id);
    // A little under the wait, so a pass a few milliseconds early still reads.
    if (last !== undefined && now.getTime() - last < every - 500)
      return 'waiting';
    this.lastRead.set(job.id, now.getTime());

    let progress: GenerationProgress;
    try {
      progress =
        ref.kind === 'image'
          ? await this.voice.readImage(ref.generationId)
          : await this.voice.readVideo(ref.generationId);
    } catch (e) {
      const status = e instanceof AiVoiceProviderError ? e.status : undefined;
      this.logger.warn(
        `ai job ${job.id} (${job.tool}): reading the generation, the provider ${
          status !== undefined ? `answered ${status}` : 'did not answer'
        }`,
      );
      // The generation is gone at the provider: nothing to wait for.
      if (status === 404 || status === 410) {
        await this.jobs.failFollowed(job.id, 'provider_failed', copy);
        this.lastRead.delete(job.id);
        return 'failed';
      }
      return 'waiting';
    }

    switch (progress.status) {
      case 'pending':
      case 'generating':
        return 'waiting';
      case 'failed': {
        this.logger.warn(
          `ai job ${job.id} (${job.tool}): the provider ended the generation (${progress.failure ?? 'unknown'})`,
        );
        // `invalid_parameters` means the Hub sent a request the provider refused: a Hub bug, logged as an error.
        if (progress.failure === 'invalid_parameters')
          this.logger.error(
            `ai job ${job.id} (${job.tool}): the provider refused the Hub's own request (invalid_parameters)`,
          );
        await this.jobs.failFollowed(
          job.id,
          progress.failure === 'moderated' ? 'moderated' : 'provider_failed',
          copy,
        );
        this.lastRead.delete(job.id);
        return 'failed';
      }
      case 'completed':
        return this.complete(job, ref, progress, copy);
    }
  }

  /** The generation is ready: open the signed link once, then finish the job (which stores the file as a stream). */
  private async complete(
    job: AiToolJob,
    ref: FlowRef,
    progress: GenerationProgress,
    copy: ProviderCopy | null,
  ): Promise<'done' | 'failed' | 'waiting'> {
    const served: readonly string[] =
      ref.kind === 'image' ? AI_IMAGE_CONTENT_TYPES : AI_VIDEO_CONTENT_TYPES;
    if (!progress.contentUrl || !progress.contentType) {
      this.logger.warn(`ai job ${job.id}: completed with no file`);
      await this.jobs.failFollowed(job.id, 'output_missing', copy);
      return 'failed';
    }
    // A type the Hub does not serve fails the job and every point goes back (AITOOLS-08).
    if (!served.includes(progress.contentType)) {
      this.logger.warn(
        `ai job ${job.id}: completed in a type the Hub does not serve`,
      );
      await this.jobs.failFollowed(job.id, 'output_type', copy);
      return 'failed';
    }
    let media;
    try {
      media = await this.voice.openGeneration(progress.contentUrl, {
        maxBytes: AI_MEDIA_MAX_BYTES[ref.kind],
        types: served,
      });
    } catch (e) {
      const status = e instanceof AiVoiceProviderError ? e.status : undefined;
      const tries = (this.fetchTries.get(job.id) ?? 0) + 1;
      this.logger.warn(
        `ai job ${job.id} (${job.tool}): the finished file could not be fetched (try ${tries}${
          status !== undefined ? `, the provider's host answered ${status}` : ''
        })`,
      );
      if (tries < FLOW_OUTPUT_TRIES) {
        this.fetchTries.set(job.id, tries);
        this.lastRead.delete(job.id);
        return 'waiting'; // the next pass reads a fresh link
      }
      this.fetchTries.delete(job.id);
      await this.jobs.failFollowed(job.id, 'output_fetch_failed', copy);
      return 'failed';
    }
    this.fetchTries.delete(job.id);
    this.lastRead.delete(job.id);
    await this.jobs.completeFollowed(job.id, {
      media: {
        kind: ref.kind,
        contentType: media.contentType,
        bytes: media.bytes,
        stream: media.stream,
        close: media.close,
      },
      ...(copy ? { endCopy: copy } : {}),
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
}
