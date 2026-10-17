import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AiToolJob } from '../../generated/prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { isUniqueViolation } from '../money/prisma-unique';
import { PlanSettingsService } from '../plan-settings/plan-settings.service';
import { PLANS_CONFIG, type PlansConfig } from '../plans/plans-config';
import { PointsError } from '../points/points-error';
import { PointsJobQuoteToken } from '../points/spend/points-job-quote-token';
import {
  jobHoldReference,
  PointsSpendService,
  type SpendHoldOutcome,
} from '../points/spend/points-spend.service';
import {
  AI_AUDIO_STORE,
  audioKeyFor,
  type AiAudioStore,
} from './audio/ai-audio-store';
import {
  AiToolError,
  JOB_FAILED_MESSAGE,
  JOB_NOT_FOUND_MESSAGE,
  KEY_REQUIRED_MESSAGE,
  KEY_REUSED_MESSAGE,
  QUOTE_CHANGED_MESSAGE,
  TEXT_EMPTY_MESSAGE,
  UNAVAILABLE_MESSAGE,
  VOICE_UNKNOWN_MESSAGE,
} from './ai-tools-error';
import type { AiJobView } from './ai-tools-view.type';
import type { CreateVoiceoverJobDto } from './ai-tools.dto';
import {
  AI_VOICE_PROVIDER,
  AiVoiceProviderError,
  type AiVoiceProvider,
} from './voice/ai-voice-provider';

/** The plan's action a VoiceOver job is priced by. */
export const VOICEOVER_ACTION = 'voiceover_per_min';
/** The setting: characters that make one minute of VoiceOver. */
export const CHARS_PER_MINUTE_SETTING = 'ai.voiceover_chars_per_minute';

const KEY_FORMAT = /^[A-Za-z0-9_-]{8,128}$/;
/** The only try a job's hold has: a failed job is never retried, a new job (and key) is. */
const ATTEMPT = 1;

export interface CreatedJob {
  job: AiJobView;
  /** True when the Idempotency-Key had already started this job: nothing ran, nothing was held again. */
  replayed: boolean;
}

/**
 * The runs of the AI tools (AITOOLS-01, R-43, PT2). A job is its points'
 * hold plus a row:
 *
 *   1. price the text (minutes from its length, the cost from the settings) and
 *      check the quote the person saw still holds;
 *   2. hold the points through POINTS-03, which refuses over a cap (named) or
 *      a short balance and then holds nothing;
 *   3. record the job and answer `working`; the provider is asked after the
 *      answer, holding no transaction, no connection and no lock;
 *   4. audio back: store it, then COMMIT the hold (the deciding step), then
 *      mark the job done. Anything else, or a hold the stale sweep already
 *      gave back: RELEASE and mark it failed.
 *
 * A late finish and the stale-hold sweep cannot both win: the points service
 * lets one of commit and release settle a hold, and the job follows whichever
 * did (`reconcile` also repairs a job whose server died after the hold settled).
 *
 * The Idempotency-Key is required. The job's id is derived from the person and
 * key, so two requests at once with one key share one hold reference and one
 * row (the unique index decides), and a retry after a lost answer finds the
 * first job. A failed job stays failed under its key; "Try again" is a new key.
 */
@Injectable()
export class AiJobService {
  private readonly logger = new Logger(AiJobService.name);
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PLANS_CONFIG) private readonly plan: PlansConfig,
    private readonly settings: PlanSettingsService,
    private readonly spend: PointsSpendService,
    private readonly quotes: PointsJobQuoteToken,
    @Inject(AI_VOICE_PROVIDER) private readonly voice: AiVoiceProvider,
    @Inject(AI_AUDIO_STORE) private readonly audio: AiAudioStore,
  ) {}

  /** Characters that make one minute, from the settings. */
  charsPerMinute(): number {
    return this.settings.number(CHARS_PER_MINUTE_SETTING);
  }

  async createVoiceover(
    wawuUserId: string,
    idempotencyKey: string | undefined,
    dto: CreateVoiceoverJobDto,
    now: Date = new Date(),
  ): Promise<CreatedJob> {
    if (!idempotencyKey || !KEY_FORMAT.test(idempotencyKey))
      throw new AiToolError('idempotency_key_required', KEY_REQUIRED_MESSAGE);
    const text = dto.text.trim();
    const requestHash = hashRequest(
      wawuUserId,
      idempotencyKey,
      dto.voiceId,
      text,
    );
    const id = jobIdFor(wawuUserId, idempotencyKey);

    // A repeat of a request that already started a job answers that job.
    const earlier = await this.prisma.aiToolJob.findUnique({ where: { id } });
    if (earlier) return this.replay(earlier, requestHash);

    if (!this.voice.configured)
      throw new AiToolError('ai_tool_unavailable', UNAVAILABLE_MESSAGE);
    if (!this.voice.voices().some((v) => v.id === dto.voiceId))
      throw new AiToolError('ai_voice_unknown', VOICE_UNKNOWN_MESSAGE);
    if (text === '') throw new AiToolError('ai_text_empty', TEXT_EMPTY_MESSAGE);

    const characters = Array.from(text).length;
    const units = Math.max(1, Math.ceil(characters / this.charsPerMinute()));
    const action = this.plan.actions.find((a) => a.id === VOICEOVER_ACTION);
    if (!action)
      throw new AiToolError('ai_tool_unavailable', UNAVAILABLE_MESSAGE);
    const costPoints = action.points * units;

    const claims = this.quotes.read(dto.quoteToken);
    if (
      !claims ||
      claims.u !== wawuUserId ||
      claims.a !== VOICEOVER_ACTION ||
      claims.e < now.getTime() ||
      claims.c !== costPoints
    )
      throw new AiToolError('quote_changed', QUOTE_CHANGED_MESSAGE, {
        costPoints,
      });

    // The deciding step for the points: refuses over a cap (named) or a short
    // balance, and holds nothing when it does. Once per reference, so a second
    // request with this key holds nothing more.
    const held = await this.spend.hold(
      {
        wawuUserId,
        action: VOICEOVER_ACTION,
        units,
        characters,
        reference: jobHoldReference(id, ATTEMPT),
      },
      { now },
    );

    const row = await this.record(
      {
        id,
        wawuUserId,
        idempotencyKey,
        requestHash,
        voiceId: dto.voiceId,
        characters,
        units,
        costPoints: held.costPoints,
        holdId: held.holdId,
      },
      requestHash,
    );
    if (row.replayed) return { job: await this.view(row.job), replayed: true };

    // Nothing is held open from here: the answer goes out, the run goes on.
    this.start(row.job, held, text);
    return { job: await this.view(row.job), replayed: false };
  }

  /** One job as it stands now. Another person's job and one that is not there are the same `404 not_found`. */
  async read(wawuUserId: string, id: string): Promise<AiJobView> {
    const row = await this.prisma.aiToolJob.findUnique({ where: { id } });
    if (!row || row.wawuUserId !== wawuUserId)
      throw new AiToolError('not_found', JOB_NOT_FOUND_MESSAGE);
    return this.view(await this.reconcile(row));
  }

  /** Waits for the jobs this server is running. For specs and a clean stop. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
  }

  // -------------------------------------------------------------------------

  private async replay(
    row: AiToolJob,
    requestHash: string,
  ): Promise<CreatedJob> {
    if (row.requestHash !== requestHash)
      throw new AiToolError('idempotency_key_reused', KEY_REUSED_MESSAGE);
    return { job: await this.view(await this.reconcile(row)), replayed: true };
  }

  /** Writes the job row; the unique index decides when two requests share a key. */
  private async record(
    data: {
      id: string;
      wawuUserId: string;
      idempotencyKey: string;
      requestHash: string;
      voiceId: string;
      characters: number;
      units: number;
      costPoints: number;
      holdId: string;
    },
    requestHash: string,
  ): Promise<{ job: AiToolJob; replayed: boolean }> {
    try {
      const job = await this.prisma.aiToolJob.create({
        data: { ...data, tool: VOICEOVER_ACTION },
      });
      return { job, replayed: false };
    } catch (e) {
      if (!isUniqueViolation(e)) {
        await this.giveBackUnwrittenHold(data.id, data.holdId);
        throw e;
      }
      // Lost the unique index: the hold is the winner's own (one hold per
      // user and key), so it is never given back from here.
      const winner = await this.prisma.aiToolJob.findUnique({
        where: { id: data.id },
      });
      if (!winner) throw e;
      if (winner.requestHash !== requestHash)
        throw new AiToolError('idempotency_key_reused', KEY_REUSED_MESSAGE);
      return { job: await this.reconcile(winner), replayed: true };
    }
  }

  /**
   * The job row could not be written, so nothing will ever settle this hold:
   * give the points back now, not at the stale-hold sweep 30 to 35 minutes on
   * (SWEEP-MONEY, AITOOLS-01 L2). Only for the failure to create the row, never
   * for the lost race on the unique index (that hold is the winner's). A row
   * under this id means another request's job holds these points and settles
   * them, so nothing is given back then. A repeat under the same key meets this
   * spent reference (`points_hold_settled`) and starts again under a new key.
   */
  private async giveBackUnwrittenHold(
    id: string,
    holdId: string,
  ): Promise<void> {
    try {
      const row = await this.prisma.aiToolJob.findUnique({
        where: { id },
        select: { id: true },
      });
      if (row) return;
      await this.spend.release(holdId);
    } catch (err) {
      this.logger.error(
        `ai job ${id}: the job could not be written and the points were not given back yet (${(err as Error).name ?? 'Error'}); the stale-hold sweep will`,
      );
    }
  }

  private start(job: AiToolJob, held: SpendHoldOutcome, text: string): void {
    const run = this.run(job, held.holdId, text)
      .catch((e: unknown) => {
        this.logger.error(
          `ai job ${job.id}: the run stopped (${(e as Error).name ?? 'Error'}); the stale-hold sweep will give the points back`,
        );
      })
      .finally(() => this.inFlight.delete(run));
    this.inFlight.add(run);
  }

  /** The provider call and what follows. Holds no transaction, connection or lock across the call. */
  private async run(
    job: AiToolJob,
    holdId: string,
    text: string,
  ): Promise<void> {
    let spoken: Awaited<ReturnType<AiVoiceProvider['speak']>>;
    try {
      spoken = await this.voice.speak({ voiceId: job.voiceId, text });
    } catch (e) {
      const code =
        e instanceof AiVoiceProviderError && e.kind === 'rejected'
          ? 'provider_failed'
          : 'provider_unavailable';
      await this.fail(job, holdId, code);
      return;
    }
    let key: string;
    try {
      key = await this.audio.put(
        job.wawuUserId,
        job.id,
        spoken.audio,
        spoken.contentType,
      );
    } catch {
      await this.fail(job, holdId, 'store_failed');
      return;
    }
    try {
      // The deciding step: the sweep that gave the points back first wins, and
      // then this finish is refused.
      await this.spend.commit(holdId);
    } catch (e) {
      if (e instanceof PointsError && e.code === 'points_hold_settled') {
        await this.audio.remove(key);
        await this.mark(job.id, 'failed', { failureCode: 'timed_out' });
        return;
      }
      throw e;
    }
    await this.mark(job.id, 'done', { audioKey: key });
  }

  /** The job did not work: every held point goes back, then the job says so. */
  private async fail(
    job: AiToolJob,
    holdId: string,
    failureCode: string,
  ): Promise<void> {
    try {
      await this.spend.release(holdId);
    } catch (e) {
      if (!(e instanceof PointsError && e.code === 'points_hold_settled')) {
        // The points stay held; the sweep gives them back and `reconcile`
        // then marks the job failed.
        this.logger.error(
          `ai job ${job.id}: the points were not given back yet (${(e as Error).name ?? 'Error'})`,
        );
        return;
      }
    }
    await this.mark(job.id, 'failed', { failureCode });
  }

  /** Moves a `working` job to its end, once; a job already ended is left as it is. */
  private async mark(
    id: string,
    state: 'done' | 'failed',
    data: { failureCode?: string; audioKey?: string },
  ): Promise<void> {
    await this.prisma.aiToolJob.updateMany({
      where: { id, state: 'working' },
      data: { state, finishedAt: new Date(), ...data },
    });
  }

  /**
   * A `working` job follows its hold: given back (by the sweep, or by a run
   * that died after releasing) means failed; spent (a run that died after the
   * commit) means done. Still held means still working.
   */
  private async reconcile(job: AiToolJob): Promise<AiToolJob> {
    if (job.state !== 'working' || !job.holdId) return job;
    const hold = await this.prisma.pointHold.findUnique({
      where: { id: job.holdId },
      select: { state: true },
    });
    if (!hold || hold.state === 'held') return job;
    if (hold.state === 'committed')
      await this.mark(job.id, 'done', {
        audioKey: audioKeyFor(job.wawuUserId, job.id),
      });
    else await this.mark(job.id, 'failed', { failureCode: 'timed_out' });
    return (
      (await this.prisma.aiToolJob.findUnique({ where: { id: job.id } })) ?? job
    );
  }

  private async view(job: AiToolJob): Promise<AiJobView> {
    let audioUrl: string | null = null;
    if (job.state === 'done' && job.audioKey) {
      try {
        audioUrl = await this.audio.urlFor(job.audioKey);
      } catch {
        // The job is done and its points are kept; the link comes on the next read.
        audioUrl = null;
      }
    }
    return {
      id: job.id,
      tool: 'voiceover',
      state: job.state,
      voiceId: job.voiceId,
      characters: job.characters,
      units: job.units,
      costPoints: job.costPoints,
      audioUrl,
      message: job.state === 'failed' ? JOB_FAILED_MESSAGE : null,
      createdAt: job.createdAt.toISOString(),
      finishedAt: job.finishedAt ? job.finishedAt.toISOString() : null,
    };
  }
}

/** The job's id from the person and key: a UUID-shaped text, the same for the same pair. */
export function jobIdFor(wawuUserId: string, idempotencyKey: string): string {
  const h = createHash('sha256')
    .update(`wawu-ai-job.v1\n${wawuUserId}\n${idempotencyKey}`)
    .digest('hex');
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** A SHA-256 of what the request asked for, salted with the person and key; the text itself is never kept. */
function hashRequest(
  wawuUserId: string,
  idempotencyKey: string,
  voiceId: string,
  text: string,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'wawu-ai-job-request.v1',
        wawuUserId,
        idempotencyKey,
        VOICEOVER_ACTION,
        voiceId,
        text,
      ]),
    )
    .digest('hex');
}
