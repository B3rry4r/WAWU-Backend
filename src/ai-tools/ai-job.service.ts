import { createHash } from 'node:crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma, type AiToolJob } from '../../generated/prisma/client';
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
import { AiInputService } from './input/ai-input-files';
import { endMarkerOf, parseFollowRef } from './dub/dub-support';
import { OWN_VOICE_ID } from './own-voice/own-voice-id';
import { OwnVoiceService } from './own-voice/own-voice.service';
import { markerOf, ProviderCopyService } from './voice/provider-copy.service';
import {
  AiToolError,
  JOB_FAILED_MESSAGE,
  JOB_NOT_FOUND_MESSAGE,
  JOB_NOT_READY_MESSAGE,
  OWN_VOICE_CONSENT_REQUIRED_MESSAGE,
  OWN_VOICE_RECORDING_REQUIRED_MESSAGE,
  KEY_REQUIRED_MESSAGE,
  KEY_REUSED_MESSAGE,
  PROMPT_EMPTY_MESSAGE,
  QUOTE_CHANGED_MESSAGE,
  TEXT_EMPTY_MESSAGE,
  UNAVAILABLE_MESSAGE,
  VOICE_UNKNOWN_MESSAGE,
} from './ai-tools-error';
import type {
  AiJobOutputView,
  AiJobPage,
  AiJobView,
} from './ai-tools-view.type';
import type {
  AiJobListQueryDto,
  CreateCaptionsJobDto,
  CreateCleanAudioJobDto,
  CreateDubbingJobDto,
  CreateMusicJobDto,
  CreateSoundEffectJobDto,
  CreateVoiceoverJobDto,
} from './ai-tools.dto';
import type {
  AiTool,
  AiToolRequest,
  AiToolRunInput,
  AiToolRunResult,
} from './tools/ai-tool';
import { toolForAction } from './tools';
import {
  CHARS_PER_MINUTE_SETTING,
  VOICEOVER_ACTION,
  VOICEOVER_TOOL,
} from './tools/voiceover.tool';
import {
  AI_VOICE_PROVIDER,
  AiVoiceProviderError,
  type AiVoiceProvider,
  type ProviderCopy,
} from './voice/ai-voice-provider';

export { CHARS_PER_MINUTE_SETTING, VOICEOVER_ACTION };

/** The body of any job route: words, a description or a file, by the tool's input kind. */
type AiJobRequestBody =
  | CreateVoiceoverJobDto
  | CreateSoundEffectJobDto
  | CreateMusicJobDto
  | CreateCaptionsJobDto
  | CreateCleanAudioJobDto
  | CreateDubbingJobDto;

const KEY_FORMAT = /^[A-Za-z0-9_-]{8,128}$/;
/** The only try a job's hold has: a failed job is never retried, a new job (and key) is. */
const ATTEMPT = 1;
const CURSOR_PREFIX = 'j1.';
export const BAD_CURSOR_MESSAGE = 'cursor is not one this list gave.';

export interface CreatedJob {
  job: AiJobView;
  /** True when the Idempotency-Key had already started this job: nothing ran, nothing was held again. */
  replayed: boolean;
}

/** What the job row keeps of a run's outputs (`outputs` column): a stored key for audio, the words for text. */
interface StoredOutput {
  kind: AiJobOutputView['kind'];
  key?: string;
  text?: string;
}

/**
 * THE ONE JOB PIPELINE of the AI tools (AITOOLS-01, AITOOLS-02, R-43, R-78,
 * PT2). Every tool in the registry (`src/ai-tools/tools/`) runs through
 * `createJob`; a job is its points' hold plus a row:
 *
 *   1. price the request into the tool's units (the tool file says how) and
 *      check the quote the person saw still holds;
 *   2. hold the points through POINTS-03, which refuses over a cap (named) or
 *      a short balance and then holds nothing;
 *   3. record the job and answer `working`; the provider is asked after the
 *      answer, holding no transaction, no connection and no lock;
 *   4. the tool's result back: store it, then COMMIT the hold (the deciding
 *      step), then mark the job done. Anything else, or a hold the stale
 *      sweep already gave back: RELEASE and mark it failed.
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
    private readonly input: AiInputService,
    private readonly copies: ProviderCopyService,
    private readonly own: OwnVoiceService,
  ) {}

  /** Characters that make one minute of VoiceOver, from the settings. */
  charsPerMinute(): number {
    return this.settings.number(CHARS_PER_MINUTE_SETTING);
  }

  /** `POST /ai-tools/voiceover/jobs` (AITOOLS-01): the first tool of the pipeline, unchanged. */
  createVoiceover(
    wawuUserId: string,
    idempotencyKey: string | undefined,
    dto: CreateVoiceoverJobDto,
    now: Date = new Date(),
  ): Promise<CreatedJob> {
    return this.createJob(VOICEOVER_TOOL, wawuUserId, idempotencyKey, dto, now);
  }

  /**
   * Starts a job of `tool` for the person: the pipeline above. `dto` is the
   * request of the tool's input kind: words and a voice for a text tool, a
   * description and its options for a prompt tool (AITOOLS-03).
   */
  async createJob(
    tool: AiTool,
    wawuUserId: string,
    idempotencyKey: string | undefined,
    dto: AiJobRequestBody,
    now: Date = new Date(),
  ): Promise<CreatedJob> {
    if (!idempotencyKey || !KEY_FORMAT.test(idempotencyKey))
      throw new AiToolError('idempotency_key_required', KEY_REQUIRED_MESSAGE);
    const asked = requestOf(tool, dto);
    const { voiceId, same } = asked;
    let req = asked.req;
    const requestHash = hashRequest(
      wawuUserId,
      idempotencyKey,
      tool.action,
      voiceId,
      asked.hashText,
      same,
    );
    const id = jobIdFor(wawuUserId, idempotencyKey);

    // A repeat of a request that already started a job answers that job.
    const earlier = await this.prisma.aiToolJob.findUnique({ where: { id } });
    if (earlier) return this.replay(earlier, requestHash);

    if (!tool.enabled(this.voice))
      throw new AiToolError('ai_tool_unavailable', UNAVAILABLE_MESSAGE);
    // A tool's own checks of the words of the request (Dubbing: a language
    // that is not on the list), before the person's file is read.
    if (tool.precheck) req = tool.precheck(req, this.settings);
    if (req.kind === 'text') {
      const wanted = req.voiceId;
      if (wanted === OWN_VOICE_ID && tool.id === 'voiceover') {
        // AITOOLS-07: "Your voice" is only the person's own, after they agreed.
        await this.assertOwnVoiceReady(wawuUserId);
      } else if (!this.voice.voices().some((v) => v.id === wanted))
        throw new AiToolError('ai_voice_unknown', VOICE_UNKNOWN_MESSAGE);
      if (req.text === '')
        throw new AiToolError('ai_text_empty', TEXT_EMPTY_MESSAGE);
    } else if (req.kind === 'prompt') {
      if (req.prompt === '')
        throw new AiToolError('ai_prompt_empty', PROMPT_EMPTY_MESSAGE);
    } else {
      // The person's own file: opened and measured by the Hub, before
      // anything is priced or held. Another person's key is not found.
      const opened = await this.input.open(wawuUserId, req.fileKey);
      req = {
        kind: 'file',
        fileKey: opened.key,
        languageCode: req.languageCode,
        targetLanguage: req.targetLanguage ?? null,
        sourceLanguage: req.sourceLanguage ?? null,
        seconds: opened.seconds,
        minutes: opened.minutes,
        bytes: opened.bytes,
        contentType: opened.contentType,
      };
    }
    // The tool's own limits (a description or a length over its setting):
    // refused before anything is priced or held.
    tool.check?.(req, this.settings, this.plan);

    const { units, characters } = tool.price(req, this.settings, this.plan);
    const action = this.plan.actions.find((a) => a.id === tool.action);
    if (!action)
      throw new AiToolError('ai_tool_unavailable', UNAVAILABLE_MESSAGE);
    const costPoints = action.points * units;

    const claims = this.quotes.read(dto.quoteToken);
    if (
      !claims ||
      claims.u !== wawuUserId ||
      claims.a !== tool.action ||
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
        action: tool.action,
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
        tool: tool.action,
        idempotencyKey,
        requestHash,
        // A dub keeps the language it was asked for in the voice column (a file
        // tool has no voice); the job view names it `targetLanguage`.
        voiceId:
          req.kind === 'file' && req.targetLanguage
            ? req.targetLanguage
            : voiceId,
        characters,
        units,
        costPoints: held.costPoints,
        holdId: held.holdId,
        inputRef: req.kind === 'file' ? req.fileKey : null,
      },
      requestHash,
    );
    if (row.replayed) return { job: await this.view(row.job), replayed: true };

    // Nothing is held open from here: the answer goes out, the run goes on.
    this.start(tool, row.job, held, req);
    return { job: await this.view(row.job), replayed: false };
  }

  /**
   * Saves a finished result to the person's library, or takes it out again
   * (AITOOLS-07, PT2b "Save"). Only the person's own finished job can be
   * saved; saving twice keeps the first time. A job that is not done cannot be
   * saved (`409 job_not_ready`); taking one out always works.
   */
  async setSaved(
    wawuUserId: string,
    id: string,
    saved: boolean,
    now: Date = new Date(),
  ): Promise<AiJobView> {
    const found = await this.prisma.aiToolJob.findUnique({ where: { id } });
    if (!found || found.wawuUserId !== wawuUserId)
      throw new AiToolError('not_found', JOB_NOT_FOUND_MESSAGE);
    const row = await this.reconcile(found);
    if (saved && row.state !== 'done')
      throw new AiToolError('job_not_ready', JOB_NOT_READY_MESSAGE);
    if (saved === (row.savedAt !== null)) return this.view(row);
    const changed = await this.prisma.aiToolJob.update({
      where: { id },
      data: { savedAt: saved ? now : null },
    });
    return this.view(changed);
  }

  /** "Your voice" needs the person's agreement and their Voice Intro recording; says which is missing. */
  private async assertOwnVoiceReady(wawuUserId: string): Promise<void> {
    if (await this.own.ready(wawuUserId)) return;
    const row = await this.prisma.voiceProfile.findUnique({
      where: { wawuUserId },
      select: { sampleKey: true },
    });
    if (!row?.sampleKey)
      throw new AiToolError(
        'own_voice_recording_required',
        OWN_VOICE_RECORDING_REQUIRED_MESSAGE,
      );
    throw new AiToolError(
      'own_voice_consent_required',
      OWN_VOICE_CONSENT_REQUIRED_MESSAGE,
    );
  }

  /** One job as it stands now. Another person's job and one that is not there are the same `404 not_found`. */
  async read(wawuUserId: string, id: string): Promise<AiJobView> {
    const row = await this.prisma.aiToolJob.findUnique({ where: { id } });
    if (!row || row.wawuUserId !== wawuUserId)
      throw new AiToolError('not_found', JOB_NOT_FOUND_MESSAGE);
    return this.view(await this.reconcile(row));
  }

  /**
   * The person's own jobs, newest first (`createdAt`, then id), in cursor
   * pages (CONVENTIONS section 6). A cursor this list did not write is a
   * plain 400. A `working` job on the page follows its hold like a read does.
   */
  async list(wawuUserId: string, query: AiJobListQueryDto): Promise<AiJobPage> {
    const limit = query.limit ?? 20;
    const after = query.cursor ? decodeCursor(query.cursor) : null;
    const rows = await this.prisma.aiToolJob.findMany({
      where: {
        wawuUserId,
        // `saved=true`: only the saved results; `saved=false`: only the ones
        // not saved; absent: every job.
        ...(query.saved === true
          ? { savedAt: { not: null } }
          : query.saved === false
            ? { savedAt: null }
            : {}),
        ...(after
          ? {
              OR: [
                { createdAt: { lt: after.createdAt } },
                { createdAt: after.createdAt, id: { lt: after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const items: AiJobView[] = [];
    for (const row of page)
      items.push(await this.view(await this.reconcile(row)));
    const last = page[page.length - 1];
    return {
      items,
      nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
    };
  }

  /**
   * A followed job's provider ids are written to its row (Dubbing, AITOOLS-05).
   * If the row has already ended (the sweep gave the points back while the
   * provider was answering) nobody will follow the work, so its project is
   * deleted at once: noted, then tried, then left to the copy sweep.
   */
  private async keepFollowRef(job: AiToolJob, ref: string): Promise<void> {
    const kept = await this.prisma.aiToolJob.updateMany({
      where: { id: job.id, state: 'working' },
      data: { providerRef: ref },
    });
    if (kept.count > 0) return;
    const parsed = parseFollowRef(ref);
    if (!parsed) return;
    const copy: ProviderCopy = { kind: 'dub', id: parsed.projectId };
    await this.copies.note(job.id, copy);
    await this.dropInput(job);
    await this.copies.discard(job.id, copy).catch(() => undefined);
  }

  /**
   * A followed job's work is done (Dubbing, called by the follower): store
   * what the provider made, COMMIT the hold, mark the job done, then delete
   * the provider's project. The same finish as any tool's. A job that is no
   * longer `working` (the sweep or a read ended it) is left alone.
   */
  async completeFollowed(
    jobId: string,
    result: AiToolRunResult & { endCopy: ProviderCopy },
  ): Promise<void> {
    const job = await this.prisma.aiToolJob.findUnique({
      where: { id: jobId },
    });
    const tool = job ? toolForAction(job.tool) : null;
    if (!job || !tool || job.state !== 'working' || !job.holdId) return;
    try {
      await this.finish(tool, job, job.holdId, result);
    } finally {
      await this.discardIfEnded(jobId, result.endCopy);
    }
  }

  /**
   * A followed job did not work (the provider failed it, it stayed too long,
   * its outputs could not be fetched): every held point goes back, the job says
   * so, and the provider's project is deleted. `copy` is null when the job never
   * learned a project.
   */
  async failFollowed(
    jobId: string,
    code: string,
    copy: ProviderCopy | null,
  ): Promise<void> {
    const job = await this.prisma.aiToolJob.findUnique({
      where: { id: jobId },
    });
    if (!job || job.state !== 'working' || !job.holdId) return;
    try {
      await this.fail(job, job.holdId, code, copy ? markerOf(copy) : undefined);
    } finally {
      if (copy) await this.discardIfEnded(jobId, copy);
    }
  }

  /** Deletes the provider's copy once the job has ended (never while it is still working: the points may not be settled yet). */
  private async discardIfEnded(
    jobId: string,
    copy: ProviderCopy,
  ): Promise<void> {
    const after = await this.prisma.aiToolJob.findUnique({
      where: { id: jobId },
      select: { state: true },
    });
    if (after && after.state !== 'working')
      await this.copies.discard(jobId, copy).catch(() => undefined);
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
      tool: string;
      idempotencyKey: string;
      requestHash: string;
      voiceId: string;
      characters: number;
      units: number;
      costPoints: number;
      holdId: string;
      inputRef: string | null;
    },
    requestHash: string,
  ): Promise<{ job: AiToolJob; replayed: boolean }> {
    try {
      const job = await this.prisma.aiToolJob.create({ data });
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

  private start(
    tool: AiTool,
    job: AiToolJob,
    held: SpendHoldOutcome,
    req: AiToolRequest,
  ): void {
    const run = this.run(tool, job, held.holdId, req)
      .catch((e: unknown) => {
        this.logger.error(
          `ai job ${job.id}: the run stopped (${(e as Error).name ?? 'Error'}); the stale-hold sweep will give the points back`,
        );
      })
      .finally(() => this.inFlight.delete(run));
    this.inFlight.add(run);
  }

  /** The tool's provider call and what follows. Holds no transaction, connection or lock across the call. */
  private async run(
    tool: AiTool,
    job: AiToolJob,
    holdId: string,
    req: AiToolRequest,
  ): Promise<void> {
    // A file tool streams the person's file to the provider for this one run.
    // Round 4: the run takes its place behind the same read gate as a quote
    // (one place per account, the global turns and bytes), is charged the
    // file's real length, and never holds the file whole. A Hub too busy to
    // take it now ends the job at once and gives every point back.
    let input: AiToolRunInput | undefined;
    if (req.kind === 'file') {
      try {
        input = {
          file: await this.input.openForRun(job.wawuUserId, req.fileKey),
        };
      } catch (e) {
        if (e instanceof ServiceUnavailableException)
          this.logger.warn(
            `ai job ${job.id} (${job.tool}): the Hub was busy reading other recordings`,
          );
        await this.fail(
          job,
          holdId,
          e instanceof ServiceUnavailableException ? 'busy' : 'file_unreadable',
        );
        return;
      }
    }
    // AITOOLS-07: "Your voice". The person's own recording, read from their own
    // row while their agreement stands, goes to the provider for this one run; the
    // voice it makes is noted on the job the moment it exists, so a server that
    // dies still knows to remove it, and is removed when the job ends.
    let noted: ProviderCopy | null = null;
    if (tool.id === 'voiceover' && job.voiceId === OWN_VOICE_ID) {
      let sample: Awaited<ReturnType<OwnVoiceService['sampleFor']>>;
      try {
        sample = await this.own.sampleFor(job.wawuUserId);
      } catch {
        await this.fail(job, holdId, 'file_unreadable');
        return;
      }
      if (!sample) {
        await this.fail(job, holdId, 'own_voice_withdrawn');
        return;
      }
      input = {
        file: sample,
        // Answers true only when the note is really on the job's row. If the
        // write failed (or the row is gone), nothing was noted, so the adapter
        // keeps the voice's removal to itself and drops it at the end of the run.
        noteCopy: async (copy) => {
          if (!(await this.copies.note(job.id, copy))) return false;
          noted = copy;
          return true;
        },
      };
    }
    let result: AiToolRunResult;
    try {
      result = await tool.run(this.voice, job, req, input);
    } catch (e) {
      const code =
        e instanceof AiVoiceProviderError && e.kind === 'rejected'
          ? 'provider_failed'
          : 'provider_unavailable';
      // The provider's HTTP status (401 for a key, 402 for a plan, 422 for a
      // refused prompt) goes in the log line only, so a lead can tell a key or
      // plan refusal from a bad prompt. It is never written to the job (the
      // `providerRef` column holds a provider job id, and a failure must not
      // overwrite it or block the AITOOLS-02 rollback) and never shown to the
      // person, who still reads "No points were taken". No body, no key.
      const status = e instanceof AiVoiceProviderError ? e.status : undefined;
      this.logger.warn(
        `ai job ${job.id} (${job.tool}): the provider ${
          status !== undefined ? `answered ${status}` : 'did not make the audio'
        } (${code})`,
      );
      await this.fail(job, holdId, code);
      // A voice made for the run and not yet removed is removed now (tried
      // again over the next minute, then by the sweep).
      if (noted)
        await this.copies.discard(job.id, noted).catch(() => undefined);
      return;
    } finally {
      // The file's place at the read gate goes back however the call ended.
      if (input && 'stream' in input.file) input.file.sent();
    }
    // A followed tool (Dubbing): the provider took the work on. The job stays
    // `working`; the row keeps the provider's ids so the follower (also after a
    // restart) can read the work again. The file stays until the job ends.
    if (result.follow) {
      await this.keepFollowRef(job, result.follow.ref);
      return;
    }
    // The provider's copy of what it made is noted on the row at once, so a
    // server that dies before it is deleted still has it to delete.
    if (result.providerCopy)
      await this.copies.note(job.id, result.providerCopy);
    try {
      await this.finish(tool, job, holdId, result);
    } finally {
      // The provider keeps no copy of a person's words or voice: its copy is
      // deleted once the result is stored or refused, however the job ends
      // (tried again over the next minute, then by the sweep, until it is gone).
      if (result.providerCopy)
        await this.copies
          .discard(job.id, result.providerCopy)
          .catch(() => undefined);
    }
  }

  /** What follows a provider answer: refuse it, or store it, COMMIT the hold, mark the job done. */
  private async finish(
    tool: AiTool,
    job: AiToolJob,
    holdId: string,
    result: AiToolRunResult,
  ): Promise<void> {
    const endRef = result.endCopy ? markerOf(result.endCopy) : undefined;
    if (result.failure) {
      await this.fail(job, holdId, result.failure, endRef);
      return;
    }
    const outputs: StoredOutput[] = [];
    let key: string | null = null;
    try {
      if (result.audio) {
        key = await this.audio.put(
          job.wawuUserId,
          job.id,
          result.audio.audio,
          result.audio.contentType,
          tool.audioFolder ?? undefined,
        );
        outputs.push({ kind: 'audio', key });
      }
    } catch {
      await this.fail(job, holdId, 'store_failed', endRef);
      return;
    }
    for (const t of result.texts ?? [])
      outputs.push({ kind: t.kind, text: t.text });
    // What the job made is written to its row BEFORE the hold is committed, so
    // a server that dies between the commit and the mark still has the result
    // (a transcript lives only in the row). A failed job clears it again.
    const made = {
      outputs: outputs as unknown as Prisma.InputJsonValue,
      // Left alone when the tool gives none: the row may hold the marker of
      // the provider's copy still to delete.
      ...(result.providerRef ? { providerRef: result.providerRef } : {}),
    };
    try {
      await this.prisma.aiToolJob.updateMany({
        where: { id: job.id, state: 'working' },
        data: made,
      });
      // The deciding step: the sweep that gave the points back first wins, and
      // then this finish is refused.
      await this.spend.commit(holdId);
    } catch (e) {
      if (e instanceof PointsError && e.code === 'points_hold_settled') {
        if (key) await this.audio.remove(key);
        // The sweep (or a read that reconciled the job) may have ended it
        // already, after the words were written above: they are cleared from
        // a failed row whoever ended it.
        await this.mark(job.id, 'failed', {
          failureCode: 'timed_out',
          outputs: Prisma.JsonNull,
          ...(endRef ? { providerRef: endRef } : {}),
        });
        await this.prisma.aiToolJob.updateMany({
          where: { id: job.id, state: 'failed' },
          data: { outputs: Prisma.JsonNull },
        });
        await this.dropInput(job);
        return;
      }
      throw e;
    }
    await this.mark(job.id, 'done', {
      ...made,
      audioKey: key,
      ...(endRef ? { providerRef: endRef } : {}),
    });
    await this.dropInput(job);
  }

  /**
   * The job did not work: every held point goes back and the job says so, in
   * ONE transaction. Apart, there is a moment when the points are back and the
   * row still says `working`; a read (`reconcile`) landing in it would end the
   * job as `timed_out` over the run's own reason (a provider that was down
   * read as a timeout). Together, a read sees the job working with its points
   * held, or failed for the reason it failed. The transaction holds nothing
   * across a network call: the provider has already answered.
   */
  private async fail(
    job: AiToolJob,
    holdId: string,
    failureCode: string,
    /** A followed job's note of the provider's project, written with the end state. */
    providerRef?: string,
  ): Promise<void> {
    const end = { failureCode, ...(providerRef ? { providerRef } : {}) };
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.spend.release(holdId, { tx });
        await this.mark(job.id, 'failed', end, tx);
      });
    } catch (e) {
      if (!(e instanceof PointsError && e.code === 'points_hold_settled')) {
        // The points stay held; the sweep gives them back and `reconcile`
        // then marks the job failed.
        this.logger.error(
          `ai job ${job.id}: the points were not given back yet (${(e as Error).name ?? 'Error'})`,
        );
        return;
      }
      // The hold was already settled (the sweep gave it back, or a run
      // committed it): the job still ends as failed, as it always has.
      await this.mark(job.id, 'failed', end);
    }
    await this.dropInput(job);
  }

  /** The job has ended: the person's uploaded file is deleted (it was read for this one run). Never throws. */
  private async dropInput(
    job: Pick<AiToolJob, 'id' | 'inputRef'>,
  ): Promise<void> {
    if (!job.inputRef) return;
    try {
      await this.input.remove(job.inputRef);
    } catch {
      this.logger.warn(`ai job ${job.id}: the uploaded file was not removed`);
    }
  }

  /** Moves a `working` job to its end, once; a job already ended is left as it is. */
  private async mark(
    id: string,
    state: 'done' | 'failed',
    data: {
      failureCode?: string;
      audioKey?: string | null;
      outputs?: Prisma.InputJsonValue | typeof Prisma.JsonNull;
      providerRef?: string | null;
    },
    db: Pick<Prisma.TransactionClient, 'aiToolJob'> = this.prisma,
  ): Promise<void> {
    await db.aiToolJob.updateMany({
      where: { id, state: 'working' },
      data: { state, finishedAt: new Date(), ...data },
    });
  }

  /**
   * A `working` job follows its hold: given back (by the sweep, or by a run
   * that died after releasing) means failed; spent (a run that died after the
   * commit) means done. Still held means still working.
   */
  async reconcile(job: AiToolJob): Promise<AiToolJob> {
    if (job.state !== 'working' || !job.holdId) return job;
    const hold = await this.prisma.pointHold.findUnique({
      where: { id: job.holdId },
      select: { state: true },
    });
    if (!hold || hold.state === 'held') return job;
    if (hold.state === 'committed') {
      // The result was written to the row before the commit; a job written
      // before that existed (or one with no outputs) falls back to its key.
      const folder = toolForAction(job.tool)?.audioFolder;
      const stored = storedOutputsOf(job).find((o) => o.kind === 'audio');
      const tool = toolForAction(job.tool);
      await this.mark(job.id, 'done', {
        audioKey:
          stored?.key ??
          (folder === null
            ? null
            : audioKeyFor(
                job.wawuUserId,
                job.id,
                folder,
                tool?.audioExtension,
              )),
        // A followed job that ends leaves its provider project to be deleted.
        ...(endMarkerOf(job.providerRef)
          ? { providerRef: endMarkerOf(job.providerRef) }
          : {}),
      });
    } else
      await this.mark(job.id, 'failed', {
        failureCode: 'timed_out',
        // A run may have written its words just before the sweep gave the
        // points back: a failed job keeps none.
        outputs: Prisma.JsonNull,
        ...(endMarkerOf(job.providerRef)
          ? { providerRef: endMarkerOf(job.providerRef) }
          : {}),
      });
    await this.dropInput(job);
    return (
      (await this.prisma.aiToolJob.findUnique({ where: { id: job.id } })) ?? job
    );
  }

  private async view(job: AiToolJob): Promise<AiJobView> {
    const tool = toolForAction(job.tool);
    const outputs: AiJobOutputView[] = [];
    let audioUrl: string | null = null;
    if (job.state === 'done') {
      for (const out of storedOutputsOf(job)) {
        if (out.key) {
          try {
            const url = await this.audio.urlFor(out.key);
            outputs.push({ kind: out.kind, url });
            if (out.kind === 'audio' && audioUrl === null) audioUrl = url;
          } catch {
            // The job is done and its points are kept; the link comes on the next read.
          }
        } else if (typeof out.text === 'string') {
          outputs.push({ kind: out.kind, text: out.text });
        }
      }
    }
    return {
      id: job.id,
      tool: tool?.id ?? VOICEOVER_TOOL.id,
      state: job.state,
      // A dub keeps its target language in the voice column; the view names it.
      voiceId:
        tool?.input.kind === 'file' && tool.input.dubbing ? '' : job.voiceId,
      targetLanguage:
        tool?.input.kind === 'file' && tool.input.dubbing ? job.voiceId : null,
      characters: job.characters,
      units: job.units,
      costPoints: job.costPoints,
      audioUrl,
      outputs,
      message: job.state === 'failed' ? JOB_FAILED_MESSAGE : null,
      saved: job.savedAt !== null,
      createdAt: job.createdAt.toISOString(),
      finishedAt: job.finishedAt ? job.finishedAt.toISOString() : null,
    };
  }
}

/** The outputs a done job keeps: its `outputs` column, or its audio key for a job written before the column. */
function storedOutputsOf(job: AiToolJob): StoredOutput[] {
  const raw = job.outputs;
  if (Array.isArray(raw)) {
    const out: StoredOutput[] = [];
    for (const item of raw as unknown[]) {
      const o = (item ?? {}) as Record<string, unknown>;
      if (o.kind !== 'audio' && o.kind !== 'text' && o.kind !== 'subtitles')
        continue;
      out.push({
        kind: o.kind,
        ...(typeof o.key === 'string' ? { key: o.key } : {}),
        ...(typeof o.text === 'string' ? { text: o.text } : {}),
      });
    }
    return out;
  }
  return job.audioKey ? [{ kind: 'audio', key: job.audioKey }] : [];
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
  action: string,
  voiceId: string,
  text: string,
  options: readonly unknown[] = [],
): string {
  // A text job's list is exactly as AITOOLS-01 wrote it (a job started before
  // a prompt tool existed still replays); a prompt job adds its options.
  return createHash('sha256')
    .update(
      JSON.stringify([
        'wawu-ai-job-request.v1',
        wawuUserId,
        idempotencyKey,
        action,
        voiceId,
        text,
        ...options,
      ]),
    )
    .digest('hex');
}

/**
 * Reads a request of the tool's input kind: the checked request, the voice id
 * the job row keeps (none for a prompt tool) and the options the Idempotency-Key
 * hash covers beyond the words (a prompt job's length and switch).
 */
function requestOf(
  tool: AiTool,
  dto: AiJobRequestBody,
): {
  req: AiToolRequest;
  voiceId: string;
  same: readonly unknown[];
  /** The words, description or file key the Idempotency-Key hash covers. */
  hashText: string;
} {
  const spec = tool.input;
  if (spec.kind === 'text') {
    const d = dto as CreateVoiceoverJobDto;
    const text = d.text.trim();
    return {
      req: { kind: 'text', text, voiceId: d.voiceId },
      voiceId: d.voiceId,
      same: [],
      hashText: text,
    };
  }
  if (spec.kind === 'file' && spec.dubbing) {
    const d = dto as CreateDubbingJobDto;
    const target = d.targetLanguage.trim().toLowerCase();
    const source = d.sourceLanguage
      ? d.sourceLanguage.trim().toLowerCase()
      : null;
    // One language a job. The language is checked against the list, in
    // `precheck`, before the file is opened; the length and the minutes are
    // the Hub's own reading, made then.
    return {
      req: {
        kind: 'file',
        fileKey: d.fileKey,
        languageCode: null,
        targetLanguage: target,
        sourceLanguage: source,
        seconds: 0,
        minutes: 0,
        bytes: 0,
        contentType: '',
      },
      voiceId: target,
      same: [source],
      hashText: d.fileKey,
    };
  }
  if (spec.kind === 'file') {
    const d = dto as CreateCaptionsJobDto & CreateCleanAudioJobDto;
    const languageCode = spec.languageCode ? (d.languageCode ?? null) : null;
    // The length and the minutes are the Hub's own reading, made after this
    // (`createJob` opens the file); only the key and the language are asked.
    return {
      req: {
        kind: 'file',
        fileKey: d.fileKey,
        languageCode,
        seconds: 0,
        minutes: 0,
        bytes: 0,
        contentType: '',
      },
      voiceId: '',
      same: [languageCode],
      hashText: d.fileKey,
    };
  }
  const d = dto as CreateSoundEffectJobDto & CreateMusicJobDto;
  const seconds =
    (spec.length.field === 'durationSeconds'
      ? d.durationSeconds
      : d.lengthSeconds) ?? null;
  const instrumental = spec.instrumental ? d.instrumental === true : null;
  const prompt = d.prompt.trim();
  return {
    req: { kind: 'prompt', prompt, seconds, instrumental },
    voiceId: '',
    same: [seconds, instrumental],
    hashText: prompt,
  };
}

/** The cursor: the last row's time and id, base64url, so the next page starts after it. */
function encodeCursor(row: Pick<AiToolJob, 'createdAt' | 'id'>): string {
  return (
    CURSOR_PREFIX +
    Buffer.from(`${row.createdAt.getTime()}.${row.id}`).toString('base64url')
  );
}

function decodeCursor(raw: string): { createdAt: Date; id: string } {
  if (!raw.startsWith(CURSOR_PREFIX))
    throw new BadRequestException(BAD_CURSOR_MESSAGE);
  const text = Buffer.from(
    raw.slice(CURSOR_PREFIX.length),
    'base64url',
  ).toString('utf8');
  const m = /^(\d{1,15})\.([0-9a-f-]{36})$/.exec(text);
  if (!m) throw new BadRequestException(BAD_CURSOR_MESSAGE);
  return { createdAt: new Date(Number(m[1])), id: m[2] };
}
