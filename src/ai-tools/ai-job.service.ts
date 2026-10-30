import { createHash } from 'node:crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma, type AiToolJob } from '../../generated/prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { isUniqueViolation } from '../money/prisma-unique';
import { NotificationService } from '../notification/notification.service';
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
import { copyOfFlow, parseFlowRef } from './flow/flow-support';
import { minutesOf, readSeconds } from './input/media-length';
import {
  AI_IMAGE_CONTENT_TYPES,
  AI_MEDIA_MAX_BYTES,
  AI_MEDIA_STORE,
  AI_VIDEO_CONTENT_TYPES,
  dayText,
  downloadNameFor,
  pieceFormatFor,
  type AiMediaStore,
} from './media/ai-media-store';
import {
  AI_INPUT_IMAGE_MAX_BYTES,
  EXTENSION_FOR_CONTENT_TYPE,
  serveAs,
} from '../storage/dto/presign-upload.dto';
import { OWN_VOICE_ID } from './own-voice/own-voice-id';
import { OwnVoiceService } from './own-voice/own-voice.service';
import { AiCloneService } from './own-voice/ai-clone.service';
import { MY_VOICE_ACTION } from './tools/my-voice.tool';
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
  CLONE_NAME_REQUIRED_MESSAGE,
  NO_FORMAT_MESSAGE,
  UNAVAILABLE_NOW_MESSAGE,
  PROMPT_EMPTY_MEDIA_MESSAGE,
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
  CreateDialogueJobDto,
  CreateDubbingJobDto,
  CreateImageJobDto,
  CreateMusicJobDto,
  CreateMyVoiceJobDto,
  CreatePhotoEditJobDto,
  CreateSoundEffectJobDto,
  CreateStemsJobDto,
  CreateTalkingPhotoJobDto,
  CreateVideoJobDto,
  CreateVideoMusicJobDto,
  CreateVoiceChangerJobDto,
  CreateVoiceoverJobDto,
} from './ai-tools.dto';
import {
  isMediaSpec,
  NO_FILE,
  type AiTool,
  type AiToolRequest,
  type AiToolRunInput,
  type AiToolRunResult,
  type MediaJobRequest,
} from './tools/ai-tool';
import {
  IMAGE_MODERATED_MESSAGE,
  SPEECH_UNREADABLE_MESSAGE,
  VIDEO_MODERATED_MESSAGE,
} from './tools/media-limits';
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
  type StreamedFile,
} from './voice/ai-voice-provider';
import type { AiPieceView } from './ai-tools-view.type';

export { CHARS_PER_MINUTE_SETTING, VOICEOVER_ACTION };

/** The setting: seconds a job must have run for the person to be told when it ends (AITOOLS-08). */
export const JOB_READY_NOTICE_SETTING = 'ai.job_ready_notice_seconds';

/** The body of any job route: words, a description or a file, by the tool's input kind. */
type AiJobRequestBody =
  | CreateVoiceoverJobDto
  | CreateSoundEffectJobDto
  | CreateMusicJobDto
  | CreateCaptionsJobDto
  | CreateCleanAudioJobDto
  | CreateDubbingJobDto
  | CreateImageJobDto
  | CreatePhotoEditJobDto
  | CreateVideoJobDto
  | CreateTalkingPhotoJobDto
  | CreateVoiceChangerJobDto
  | CreateDialogueJobDto
  | CreateMyVoiceJobDto
  | CreateVideoMusicJobDto
  | CreateStemsJobDto;

const KEY_FORMAT = /^[A-Za-z0-9_-]{8,128}$/;
/** The only try a job's hold has: a failed job is never retried, a new job (and key) is. */
const ATTEMPT = 1;
const CURSOR_PREFIX = 'j1.';
export const BAD_CURSOR_MESSAGE = 'cursor is not one this list gave.';
const RESULT_NOT_FOUND_MESSAGE = "We couldn't find that result.";

export interface CreatedJob {
  job: AiJobView;
  /** True when the Idempotency-Key had already started this job: nothing ran, nothing was held again. */
  replayed: boolean;
}

/** What the job row keeps of a run's outputs (`outputs` column): a stored key for a file, the words for text. */
interface StoredOutput {
  kind: AiJobOutputView['kind'];
  key?: string;
  text?: string;
  /** AITOOLS-08: a Studio result's type and size, kept with the key (an older audio output has neither). */
  contentType?: string;
  bytes?: number;
  /** AITOOLS-12: the plain name of one part of a split song ("Voice", "Drums"); absent for every other output. */
  label?: string;
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
    // R-109 (AITOOLS-08): where the pictures and videos are kept and copied from. Absent in a spec that builds only the older tools.
    @Optional()
    @Inject(AI_MEDIA_STORE)
    private readonly media?: AiMediaStore,
    // R-109 (AITOOLS-08): tells the person when a long job ends. Absent in a spec that builds no notifications.
    @Optional() private readonly notices?: NotificationService,
    // R-109 (AITOOLS-11): the person's saved clone of their own voice. Absent in a spec that builds only the older tools.
    @Optional() private readonly savedVoices?: AiCloneService,
  ) {}

  /** The saved-clone service; the tools that need it are not built without it. */
  private get clones(): AiCloneService {
    if (!this.savedVoices)
      throw new AiToolError('ai_tool_unavailable', UNAVAILABLE_MESSAGE);
    return this.savedVoices;
  }

  /**
   * Refuses a voice that is not on the person's list (AITOOLS-11): a Hub voice, or `own` while they keep a saved clone.
   * Nothing is held when it throws.
   */
  private async assertVoicesKnown(
    wawuUserId: string,
    voiceIds: readonly string[],
  ): Promise<void> {
    const hub = new Set(this.voice.voices().map((v) => v.id));
    let ownKept: boolean | null = null;
    for (const id of voiceIds) {
      if (hub.has(id)) continue;
      if (id === OWN_VOICE_ID && this.savedVoices) {
        ownKept ??= (await this.savedVoices.activeFor(wawuUserId)) !== null;
        if (ownKept) continue;
      }
      throw new AiToolError('ai_voice_unknown', VOICE_UNKNOWN_MESSAGE);
    }
  }

  /** Whether the tool's listing switch is on (AITOOLS-08): a tool with no switch, one of the seven older ones, is always listed. */
  private listed(tool: AiTool): boolean {
    return (
      !tool.listingSetting || this.settings.number(tool.listingSetting) === 1
    );
  }

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

    if (!tool.enabled(this.voice) || !this.listed(tool))
      throw new AiToolError('ai_tool_unavailable', UNAVAILABLE_MESSAGE);
    // A tool's own checks of the words of the request (Dubbing: a language
    // that is not on the list), before the person's file is read.
    if (tool.precheck) req = tool.precheck(req, this.settings);
    if (req.kind === 'text') {
      const wanted = req.voiceId;
      if (
        wanted === OWN_VOICE_ID &&
        (tool.id === 'voiceover' || tool.id === 'quick-voice')
      ) {
        // AITOOLS-11: the person's SAVED clone wins. AITOOLS-07: without one, VoiceOver reads in a clone made from
        // the Voice Intro for this run, "Your voice" being only the person's own and only after they agreed.
        const saved = this.savedVoices
          ? await this.savedVoices.activeFor(wawuUserId)
          : null;
        if (!saved) {
          if (tool.id === 'voiceover')
            await this.assertOwnVoiceReady(wawuUserId);
          else throw new AiToolError('ai_voice_unknown', VOICE_UNKNOWN_MESSAGE);
        }
      } else if (!this.voice.voices().some((v) => v.id === wanted))
        throw new AiToolError('ai_voice_unknown', VOICE_UNKNOWN_MESSAGE);
      if (req.text === '')
        throw new AiToolError('ai_text_empty', TEXT_EMPTY_MESSAGE);
    } else if (req.kind === 'dialogue') {
      // AITOOLS-11: every line's voice is on the person's list (a Hub voice, or their own saved clone).
      await this.assertVoicesKnown(
        wawuUserId,
        req.lines.map((l) => l.voiceId),
      );
    } else if (req.kind === 'prompt') {
      if (req.prompt === '')
        throw new AiToolError('ai_prompt_empty', PROMPT_EMPTY_MESSAGE);
    } else if (req.kind === 'media') {
      // A Studio tool (AITOOLS-09, AITOOLS-10): its description, then the
      // person's photo and voice opened and measured by the Hub, before
      // anything is priced or held. Another person's key is not found.
      if (
        isMediaSpec(tool.input) &&
        tool.input.maxCharactersSetting !== null &&
        req.prompt === ''
      )
        throw new AiToolError('ai_prompt_empty', PROMPT_EMPTY_MEDIA_MESSAGE);
      req = await this.openMedia(wawuUserId, req);
    } else {
      // The person's own file: opened and measured by the Hub, before
      // anything is priced or held. Another person's key is not found.
      if (tool.input.kind === 'file' && tool.input.voice)
        await this.assertVoicesKnown(wawuUserId, [req.voiceId ?? '']);
      if (tool.id === 'my-voice') {
        // AITOOLS-11: a name for the voice, and no clone yet; the words agreed to were checked against the person's own line.
        if (!req.cloneName)
          throw new AiToolError('ai_text_empty', CLONE_NAME_REQUIRED_MESSAGE);
        await this.clones.assertCanMake(wawuUserId);
      }
      const opened = await this.input.open(wawuUserId, req.fileKey);
      // The tool's own look at what the Hub read from the file (a video where audio is needed, a length over its setting).
      tool.checkFile?.(opened, this.settings);
      req = {
        ...req,
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
        inputRef:
          req.kind === 'file'
            ? req.fileKey
            : req.kind === 'media'
              ? inputRefOf(req)
              : null,
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
    // AITOOLS-09 and -10: a picture or video whose row has ended already: the
    // person's assets at the provider are deleted at once (noted, then tried).
    const flow = parsed ? null : parseFlowRef(ref);
    const copy: ProviderCopy | null = parsed
      ? { kind: 'dub', id: parsed.projectId }
      : flow
        ? copyOfFlow(flow)
        : null;
    if (!copy) return;
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
    result: AiToolRunResult,
  ): Promise<void> {
    const job = await this.prisma.aiToolJob.findUnique({
      where: { id: jobId },
    });
    const tool = job ? toolForAction(job.tool) : null;
    if (!job || !tool || job.state !== 'working' || !job.holdId) {
      // Nothing will keep the result (the job ended another way): the stream is given back.
      result.media?.close();
      return;
    }
    try {
      await this.finish(tool, job, job.holdId, result);
    } finally {
      if (result.endCopy) await this.discardIfEnded(jobId, result.endCopy);
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
    /** The provider's copy of a person's voice or photo, noted on the job the moment it exists (AITOOLS-07, AITOOLS-09). */
    let noted: ProviderCopy | null = null;
    /** The Studio files opened for this run, so every place at the read gate goes back however the call ended. */
    const opened: StreamedFile[] = [];
    // AITOOLS-11: "Clone your own voice" writes the person's reservation BEFORE the provider is asked, under one
    // advisory lock with the counts, so two taps at once make one clone. A reservation it cannot have ends the job
    // with every point back and no call to the provider.
    if (tool.id === 'my-voice' && req.kind === 'file') {
      let reserved: 'reserved' | 'exists' | 'full';
      try {
        reserved = await this.clones.reserve(
          job.wawuUserId,
          job.id,
          req.cloneName ?? '',
          req.consentLine ?? '',
        );
      } catch {
        await this.fail(job, holdId, 'provider_unavailable');
        return;
      }
      if (reserved !== 'reserved') {
        await this.fail(job, holdId, 'clone_exists');
        return;
      }
    }
    // AITOOLS-11: the voice "Your voice" means is the person's SAVED clone, read from their own row now (it may have
    // been removed since the job was priced). VoiceOver falls back to a clone made from the Voice Intro for the run.
    let savedVoice: string | undefined;
    const asksOwn =
      (req.kind === 'text' && job.voiceId === OWN_VOICE_ID) ||
      (req.kind === 'file' &&
        tool.id === 'voice-changer' &&
        job.voiceId === OWN_VOICE_ID) ||
      (req.kind === 'dialogue' &&
        req.lines.some((l) => l.voiceId === OWN_VOICE_ID));
    if (asksOwn) {
      try {
        savedVoice =
          (await this.clones.activeFor(job.wawuUserId))?.providerVoiceId ??
          undefined;
      } catch {
        savedVoice = undefined;
      }
      if (!savedVoice && tool.id !== 'voiceover') {
        await this.fail(job, holdId, 'own_voice_withdrawn');
        return;
      }
    }
    if (req.kind === 'media') {
      // AITOOLS-09, AITOOLS-10: the person's photo and voice, streamed to the
      // provider as assets for this one run, behind the same read gate. They
      // are opened one at a time, when the tool asks (the gate gives an account
      // one place at a time). A Hub too busy to take one now ends the job and
      // gives every point back.
      const lazy = (open: () => Promise<StreamedFile>) => async () => {
        const file = await open();
        opened.push(file);
        return file;
      };
      const photoKey = req.photoKey;
      const speech = req.speech;
      const media: NonNullable<AiToolRunInput['media']> = {
        ...(photoKey
          ? {
              photo: lazy(() =>
                this.input.openForRun(
                  job.wawuUserId,
                  photoKey,
                  AI_INPUT_IMAGE_MAX_BYTES,
                ),
              ),
            }
          : {}),
        ...(speech
          ? {
              speech: lazy(() =>
                speech.source === 'upload'
                  ? this.input.openForRun(job.wawuUserId, speech.key)
                  : this.openJobSpeech(speech.key),
              ),
            }
          : {}),
      };
      if (photoKey || speech)
        input = {
          file: NO_FILE,
          media,
          // Notes the provider's copies of the person's photo and voice on the job as soon as they exist, so a server that dies still knows to delete them.
          noteCopy: async (copy) => {
            if (!(await this.copies.note(job.id, copy))) return false;
            noted = copy;
            return true;
          },
        };
    } else if (req.kind === 'file') {
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
    if (
      tool.id === 'voiceover' &&
      job.voiceId === OWN_VOICE_ID &&
      !savedVoice
    ) {
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
    if (savedVoice) input = { ...(input ?? { file: NO_FILE }), savedVoice };
    let result: AiToolRunResult;
    try {
      result = await tool.run(this.voice, job, req, input);
    } catch (e) {
      // AITOOLS-12: a 403 from the music routes means the provider's plan does not cover them. The person reads "This
      // isn't available right now. No points were taken."; the owner reads the log line (an owner item, not a bug).
      const planRefused =
        e instanceof AiVoiceProviderError &&
        e.status === 403 &&
        (tool.id === 'video-music' || tool.id === 'stems');
      if (planRefused)
        this.logger.error(
          `OWNER ITEM: ai job ${job.id} (${job.tool}): the provider answered 403, so its plan does not cover the music routes (Subscription required)`,
        );
      const code = planRefused
        ? 'provider_plan'
        : e instanceof ServiceUnavailableException
          ? 'busy' // a Studio file the Hub was too busy to open (AITOOLS-09)
          : e instanceof AiVoiceProviderError && e.kind === 'rejected'
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
      for (const file of opened) file.sent();
    }
    // A followed tool (Dubbing): the provider took the work on. The job stays
    // `working`; the row keeps the provider's ids so the follower (also after a
    // restart) can read the work again. The file stays until the job ends.
    if (result.follow) {
      await this.keepFollowRef(job, result.follow.ref);
      return;
    }
    // AITOOLS-11: the provider's id of the clone goes on the person's reservation the moment it answers, so a server
    // that dies after this still knows the voice is there. A reservation that was removed meanwhile (the person
    // removed it, or the account is going) means the voice is not wanted: it is deleted and the job gives its points back.
    if (result.clone) {
      let attached: 'kept' | 'removed' | 'missing' = 'missing';
      try {
        attached = await this.clones.attach(
          job.id,
          result.clone.providerVoiceId,
        );
      } catch {
        attached = 'missing';
      }
      if (attached !== 'kept') {
        if (attached === 'missing')
          await this.voice
            .deleteOwnVoice(result.clone.providerVoiceId)
            .catch(() => undefined);
        await this.fail(job, holdId, 'clone_removed');
        return;
      }
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
    try {
      await this.finishInner(tool, job, holdId, result);
    } finally {
      // A result that came as a stream is given back however the job ended.
      result.media?.close();
    }
  }

  private async finishInner(
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
    /** Every audio file stored for the job, so a job that does not keep its points removes them all (AITOOLS-12: one for each part). */
    const audioKeys: string[] = [];
    /** The key of a picture or video (not an audio key: `audioKey` holds audio only). */
    let mediaKey: string | null = null;
    try {
      if (result.audio) {
        key = await this.audio.put(
          job.wawuUserId,
          job.id,
          result.audio.audio,
          result.audio.contentType,
          tool.audioFolder ?? undefined,
        );
        audioKeys.push(key);
        outputs.push({ kind: 'audio', key });
      }
      for (const part of result.audios ?? []) {
        // AITOOLS-12: each part under a key of the Hub's own making (the job and the part), never a name from the provider.
        const partKey = await this.audio.put(
          job.wawuUserId,
          `${job.id}-${part.slug}`,
          part.audio.audio,
          part.audio.contentType,
          tool.audioFolder ?? undefined,
        );
        audioKeys.push(partKey);
        key ??= partKey;
        outputs.push({ kind: 'audio', key: partKey, label: part.label });
      }
      if (result.media) {
        // A type the Hub does not serve for this kind fails the job: nothing is
        // stored and every held point goes back (AITOOLS-08).
        const served: readonly string[] =
          result.media.kind === 'image'
            ? AI_IMAGE_CONTENT_TYPES
            : AI_VIDEO_CONTENT_TYPES;
        if (
          !this.media ||
          !tool.mediaFolder ||
          !served.includes(result.media.contentType)
        ) {
          await this.fail(job, holdId, 'output_type', endRef);
          return;
        }
        const stored = await this.media.put(
          job.wawuUserId,
          job.id,
          result.media.stream,
          result.media.contentType,
          tool.mediaFolder,
          AI_MEDIA_MAX_BYTES[result.media.kind],
        );
        mediaKey = stored.key;
        outputs.push({
          kind: result.media.kind,
          key: stored.key,
          contentType: result.media.contentType,
          bytes: stored.bytes,
        });
      }
    } catch {
      for (const stored of audioKeys) await this.audio.remove(stored);
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
        for (const stored of audioKeys) await this.audio.remove(stored);
        if (mediaKey) await this.media?.remove(mediaKey);
        // AITOOLS-11: a clone the provider made for a job that does not keep its points is given back.
        if (job.tool === MY_VOICE_ACTION)
          await this.clones.discardByJob(job.id);
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
    const changed = await this.mark(job.id, 'done', {
      ...made,
      audioKey: key,
      ...(endRef ? { providerRef: endRef } : {}),
    });
    await this.dropInput(job);
    if (changed) await this.noticeEnded(job.id, 'done');
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
    let changed = false;
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.spend.release(holdId, { tx });
        changed = await this.mark(job.id, 'failed', end, tx);
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
      changed = await this.mark(job.id, 'failed', end);
    }
    await this.dropInput(job);
    // AITOOLS-11: a clone (or its reservation) of a job that did not keep its points is given back.
    if (job.tool === MY_VOICE_ACTION) await this.clones.discardByJob(job.id);
    if (changed) await this.noticeEnded(job.id, 'failed');
  }

  /** The job has ended: the person's uploaded file is deleted (it was read for this one run). Never throws. */
  private async dropInput(
    job: Pick<AiToolJob, 'id' | 'inputRef'>,
  ): Promise<void> {
    if (!job.inputRef) return;
    // A Talking photo keeps two (the photo, then the recording), one per line.
    for (const key of job.inputRef.split('\n')) {
      if (key === '') continue;
      try {
        await this.input.remove(key);
      } catch {
        this.logger.warn(`ai job ${job.id}: the uploaded file was not removed`);
      }
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
  ): Promise<boolean> {
    const written = await db.aiToolJob.updateMany({
      where: { id, state: 'working' },
      data: { state, finishedAt: new Date(), ...data },
    });
    // True only for the one write that really ended the job (a replay, the sweep and a late finish cannot all say so).
    return written.count > 0;
  }

  /**
   * A job that ran longer than `ai.job_ready_notice_seconds` tells the person
   * when it ends (AITOOLS-08, kind `ai_job_ready`, target the job). Called only
   * by the one write that ended the job, so it is told once. A short job tells
   * nothing. Never throws: a notice is a side effect of the end, not the end.
   */
  private async noticeEnded(
    jobId: string,
    outcome: 'done' | 'failed',
  ): Promise<void> {
    if (!this.notices) return;
    try {
      const row = await this.prisma.aiToolJob.findUnique({
        where: { id: jobId },
        select: {
          wawuUserId: true,
          tool: true,
          createdAt: true,
          finishedAt: true,
        },
      });
      const tool = row ? toolForAction(row.tool) : null;
      if (!row || !tool) return;
      const ranMs =
        (row.finishedAt ?? new Date()).getTime() - row.createdAt.getTime();
      if (ranMs <= this.settings.number(JOB_READY_NOTICE_SETTING) * 1000)
        return;
      await this.notices.emit({
        kind: 'ai_job_ready',
        userWawuId: row.wawuUserId,
        what: outputLabelOf(tool.id),
        outcome,
        about: { target: { kind: 'ai_job', id: jobId } },
      });
    } catch {
      this.logger.warn(`ai job ${jobId}: the notice was not written`);
    }
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
      // A split song has no single key to fall back to; its parts are always written to the row before the commit.
      const noFallback = tool?.id === 'stems';
      const changedDone = await this.mark(job.id, 'done', {
        audioKey:
          stored?.key ??
          (folder === null || noFallback
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
      if (changedDone) await this.noticeEnded(job.id, 'done');
    } else {
      const changedFailed = await this.mark(job.id, 'failed', {
        failureCode: 'timed_out',
        // A run may have written its words just before the sweep gave the
        // points back: a failed job keeps none.
        outputs: Prisma.JsonNull,
        ...(endMarkerOf(job.providerRef)
          ? { providerRef: endMarkerOf(job.providerRef) }
          : {}),
      });
      if (changedFailed) await this.noticeEnded(job.id, 'failed');
    }
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
      const stored = storedOutputsOf(job);
      const sizes = await this.sizesOf(stored);
      for (const out of stored) {
        if (out.key) {
          const isMedia = out.kind === 'image' || out.kind === 'video';
          if (isMedia && !this.media) continue;
          try {
            const url = isMedia
              ? await this.media!.urlFor(out.key)
              : await this.audio.urlFor(out.key);
            const item: AiJobOutputView = { kind: out.kind, url };
            if (this.media)
              Object.assign(item, await this.fileFields(job, tool, out, sizes));
            outputs.push(item);
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
      message: job.state === 'failed' ? failedMessage(job, tool) : null,
      saved: job.savedAt !== null,
      createdAt: job.createdAt.toISOString(),
      finishedAt: job.finishedAt ? job.finishedAt.toISOString() : null,
    };
  }

  /** The real sizes of the stored files an older job kept no size for (one read for the page of outputs). */
  private async sizesOf(
    stored: readonly StoredOutput[],
  ): Promise<Map<string, number>> {
    const sizes = new Map<string, number>();
    if (!this.media) return sizes;
    const keys = stored
      .filter((o) => o.key && o.bytes === undefined)
      .map((o) => o.key as string);
    if (keys.length === 0) return sizes;
    const rows = await this.prisma.storageObject.findMany({
      where: { key: { in: keys } },
      select: { key: true, bytes: true },
    });
    for (const r of rows) sizes.set(r.key, Number(r.bytes));
    return sizes;
  }

  /** AITOOLS-08: what an output that is a file says about itself, beside its link. */
  private async fileFields(
    job: AiToolJob,
    tool: AiTool | null,
    out: StoredOutput,
    sizes: ReadonlyMap<string, number>,
  ): Promise<
    Pick<
      AiJobOutputView,
      'contentType' | 'bytes' | 'name' | 'downloadUrl' | 'pieceFormat'
    >
  > {
    const key = out.key as string;
    const contentType = out.contentType ?? serveAs(key).contentType;
    const bytes = out.bytes ?? sizes.get(key);
    const ext =
      EXTENSION_FOR_CONTENT_TYPE[contentType] ?? key.split('.').pop() ?? 'bin';
    return {
      contentType,
      ...(bytes !== undefined ? { bytes } : {}),
      name: out.label ?? outputLabelOf(tool?.id),
      downloadUrl: await this.media!.downloadUrlFor(
        key,
        downloadNameFor(
          out.label
            ? `${tool?.id ?? 'result'}-${out.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
            : (tool?.id ?? 'result'),
          job.finishedAt ?? job.createdAt,
          ext,
        ),
      ),
      pieceFormat: pieceFormatFor(contentType),
    };
  }

  /**
   * The Studio result becomes a piece (`POST /ai-tools/jobs/{id}/piece`,
   * AITOOLS-08, R-109): the Hub copies the finished output into the person's
   * own `content/full` folder as an upload counted like any upload, and answers
   * what Create's draft holds. Only the person's own finished job; an output no
   * Create format takes is `409 no_format`; a person with no room or no way to
   * publish is refused as the presign refuses (nothing is copied). The same call
   * again finds the same copy until the person releases it. Nothing is
   * published: `POST /content` and its gates run as today.
   */
  async makePiece(
    wawuUserId: string,
    id: string,
    outputIndex: number,
    idempotencyKey: string | undefined,
  ): Promise<{ piece: AiPieceView; replayed: boolean }> {
    if (!idempotencyKey || !KEY_FORMAT.test(idempotencyKey))
      throw new AiToolError('idempotency_key_required', KEY_REQUIRED_MESSAGE);
    const found = await this.prisma.aiToolJob.findUnique({ where: { id } });
    if (!found || found.wawuUserId !== wawuUserId)
      throw new AiToolError('not_found', JOB_NOT_FOUND_MESSAGE);
    const row = await this.reconcile(found);
    if (row.state !== 'done')
      throw new AiToolError('job_not_ready', JOB_NOT_READY_MESSAGE);
    const out = storedOutputsOf(row)[outputIndex];
    if (!out) throw new AiToolError('not_found', RESULT_NOT_FOUND_MESSAGE);
    // Words and subtitles are kept in the row and have no file to copy.
    if (!out.key) throw new AiToolError('no_format', NO_FORMAT_MESSAGE);
    const contentType = out.contentType ?? serveAs(out.key).contentType;
    const format = pieceFormatFor(contentType);
    if (!format) throw new AiToolError('no_format', NO_FORMAT_MESSAGE);
    if (!this.media)
      throw new AiToolError('ai_tool_unavailable', UNAVAILABLE_MESSAGE);
    const copy = await this.media.copyIntoContent(
      wawuUserId,
      out.key,
      `${row.id}:${outputIndex}`,
    );
    const tool = toolForAction(row.tool);
    const at = row.finishedAt ?? row.createdAt;
    const ext = EXTENSION_FOR_CONTENT_TYPE[copy.contentType] ?? 'bin';
    const day = dayText(at);
    return {
      replayed: copy.replayed,
      piece: {
        format,
        full: {
          key: copy.key,
          fileUrl: copy.fileUrl,
          contentType: copy.contentType,
          bytes: copy.bytes,
          name: downloadNameFor(
            out.label
              ? `${tool?.id ?? 'result'}-${out.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
              : (tool?.id ?? 'result'),
            at,
            ext,
          ),
        },
        suggestedTitle: `${out.label ?? outputLabelOf(tool?.id)}, ${day.day} ${
          day.month.charAt(0).toUpperCase() + day.month.slice(1)
        } ${day.year}`,
      },
    };
  }

  /**
   * A Talking photo's voice, opened and measured by the Hub before anything is
   * priced or held (AITOOLS-10): the person's own recording (an MP3 or WAV in
   * `ai/input-audio`), or the audio of one of their own finished voice results.
   * Another person's key or job is not found; a result that is not finished is
   * `409 job_not_ready`; anything else the Hub cannot read the length of is
   * `422 ai_speech_unreadable`.
   */
  async openSpeech(
    wawuUserId: string,
    ask: { audioKey?: string | null; sourceJobId?: string | null },
  ): Promise<NonNullable<MediaJobRequest['speech']>> {
    if (ask.audioKey) {
      const opened = await this.input.open(wawuUserId, ask.audioKey);
      if (
        opened.contentType !== 'audio/mpeg' &&
        opened.contentType !== 'audio/wav'
      )
        throw new AiToolError(
          'ai_speech_unreadable',
          SPEECH_UNREADABLE_MESSAGE,
        );
      return {
        source: 'upload',
        key: opened.key,
        seconds: opened.seconds,
        bytes: opened.bytes,
        contentType: opened.contentType,
      };
    }
    const jobId = ask.sourceJobId;
    if (!jobId)
      throw new AiToolError('ai_speech_required', SPEECH_UNREADABLE_MESSAGE);
    const found = await this.prisma.aiToolJob.findUnique({
      where: { id: jobId },
    });
    if (!found || found.wawuUserId !== wawuUserId)
      throw new AiToolError('not_found', JOB_NOT_FOUND_MESSAGE);
    const row = await this.reconcile(found);
    if (row.state !== 'done')
      throw new AiToolError('job_not_ready', JOB_NOT_READY_MESSAGE);
    const out = storedOutputsOf(row).find(
      (o) => o.kind === 'audio' && o.key && /\.(mp3|wav)$/.test(o.key),
    );
    if (!out?.key || !this.media)
      throw new AiToolError('ai_speech_unreadable', SPEECH_UNREADABLE_MESSAGE);
    let seconds: number | null;
    let contentType: string;
    let bytes: number;
    try {
      const read = await this.media.read(out.key, this.input.maxBytes());
      bytes = read.audio.length;
      contentType = read.contentType;
      seconds = await readSeconds(read.audio, { transfer: true });
    } catch {
      seconds = null;
      contentType = '';
      bytes = 0;
    }
    if (seconds === null)
      throw new AiToolError('ai_speech_unreadable', SPEECH_UNREADABLE_MESSAGE);
    return { source: 'job', key: out.key, seconds, bytes, contentType };
  }

  /** The Studio request with the person's photo and voice opened: their real types, sizes and the voice's length (the seconds that price a Talking photo). */
  private async openMedia(
    wawuUserId: string,
    req: MediaJobRequest,
  ): Promise<MediaJobRequest> {
    let photo: MediaJobRequest['photo'] = null;
    if (req.photoKey) {
      const opened = await this.input.openPhoto(wawuUserId, req.photoKey);
      photo = { bytes: opened.bytes, contentType: opened.contentType };
    }
    let speech: MediaJobRequest['speech'] = null;
    let seconds = req.seconds;
    if (req.audioKey || req.sourceJobId) {
      speech = await this.openSpeech(wawuUserId, req);
      seconds = Math.max(
        1,
        minutesOf(speech.seconds) > 0 ? Math.ceil(speech.seconds) : 1,
      );
    }
    return { ...req, photo, speech, seconds };
  }

  /** A finished result's audio opened to be streamed to the provider as the voice of a Talking photo. */
  private async openJobSpeech(key: string): Promise<StreamedFile> {
    if (!this.media)
      throw new AiToolError('ai_tool_unavailable', UNAVAILABLE_MESSAGE);
    const opened = await this.media.open(key, this.input.maxBytes());
    return {
      bytes: opened.bytes,
      contentType: opened.contentType,
      stream: opened.stream,
      sent: () => opened.stream.destroy(),
    };
  }
}

/** What a failed job says (PT2c): the Hub's own sentence, the content refusal in its own words. */
function failedMessage(job: AiToolJob, tool: AiTool | null): string {
  if (job.failureCode === 'provider_plan') return UNAVAILABLE_NOW_MESSAGE;
  if (job.failureCode === 'moderated')
    return tool?.id === 'video' || tool?.id === 'talking-photo'
      ? VIDEO_MODERATED_MESSAGE
      : IMAGE_MODERATED_MESSAGE;
  return JOB_FAILED_MESSAGE;
}

/** A plain label for what a tool made, never a provider or model name (R-68). */
const OUTPUT_LABELS: Readonly<Record<string, string>> = {
  voiceover: 'Voice over',
  'quick-voice': 'Quick voice',
  'sound-effect': 'Sound effect',
  music: 'Music track',
  'clean-audio': 'Cleaned audio',
  dubbing: 'Dubbed audio',
  image: 'Image',
  'photo-edit': 'Edited photo',
  video: 'Video',
  'talking-photo': 'Talking photo',
  'voice-changer': 'Voice changer',
  dialogue: 'Dialogue',
  'video-music': 'Music for a video',
  stems: 'Song part',
};
function outputLabelOf(toolId: string | undefined): string {
  return (toolId && OUTPUT_LABELS[toolId]) || 'Result';
}

/** The keys of the person's own files a Studio job keeps until it ends: the photo, then the recording (one per line). */
function inputRefOf(req: MediaJobRequest): string | null {
  const keys = [
    req.photoKey,
    req.speech?.source === 'upload' ? req.speech.key : null,
  ].filter((k): k is string => k !== null);
  return keys.length > 0 ? keys.join('\n') : null;
}

/** The outputs a done job keeps: its `outputs` column, or its audio key for a job written before the column. */
function storedOutputsOf(job: AiToolJob): StoredOutput[] {
  const raw = job.outputs;
  if (Array.isArray(raw)) {
    const out: StoredOutput[] = [];
    for (const item of raw as unknown[]) {
      const o = (item ?? {}) as Record<string, unknown>;
      if (
        o.kind !== 'audio' &&
        o.kind !== 'text' &&
        o.kind !== 'subtitles' &&
        o.kind !== 'image' &&
        o.kind !== 'video'
      )
        continue;
      out.push({
        kind: o.kind,
        ...(typeof o.key === 'string' ? { key: o.key } : {}),
        ...(typeof o.text === 'string' ? { text: o.text } : {}),
        ...(typeof o.contentType === 'string'
          ? { contentType: o.contentType }
          : {}),
        ...(typeof o.bytes === 'number' ? { bytes: o.bytes } : {}),
        ...(typeof o.label === 'string' ? { label: o.label } : {}),
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
  if (spec.kind === 'dialogue') {
    // AITOOLS-11: the lines of a scene, each trimmed; the Hub counts every character, and an empty line is refused in the tool's check.
    const d = dto as CreateDialogueJobDto;
    const lines = (d.lines ?? []).map((l) => ({
      text: l.text.trim(),
      voiceId: l.voiceId,
    }));
    return {
      req: {
        kind: 'dialogue',
        lines,
        characters: lines.reduce((n, l) => n + Array.from(l.text).length, 0),
        model: '',
      },
      voiceId: '',
      same: [],
      hashText: JSON.stringify(lines),
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
    const d = dto as CreateCaptionsJobDto &
      CreateCleanAudioJobDto &
      Partial<
        CreateVoiceChangerJobDto &
          CreateVideoMusicJobDto &
          CreateStemsJobDto &
          CreateMyVoiceJobDto
      >;
    const languageCode = spec.languageCode ? (d.languageCode ?? null) : null;
    // AITOOLS-11 and -12: what the newer file tools ask beyond the file. A tool that asks none of it hashes exactly
    // as it always did (`[languageCode]`), so a job started before they existed still replays.
    const voiceId = spec.voice ? (d.voiceId ?? '') : '';
    const description = spec.description
      ? (d.description ?? '').trim() || null
      : null;
    const parts = spec.parts ? (d.parts === 6 ? 6 : 2) : null;
    const cloneName = spec.clone ? (d.name ?? '').trim() : null;
    const consentLine = spec.clone ? (d.consentLine ?? '') : null;
    const newer = spec.voice || spec.description || spec.parts || spec.clone;
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
        voiceId,
        description,
        parts,
        cloneName,
        consentLine,
      },
      voiceId,
      same: newer
        ? [languageCode, voiceId, description, parts, cloneName]
        : [languageCode],
      hashText: d.fileKey,
    };
  }
  if (isMediaSpec(spec)) {
    const d = dto as Partial<
      CreateImageJobDto &
        CreatePhotoEditJobDto &
        CreateVideoJobDto &
        CreateTalkingPhotoJobDto
    >;
    const prompt = (d.prompt ?? '').trim();
    const shape = d.shape ?? null;
    const secondsAsked = d.seconds ?? null;
    return {
      req: {
        kind: 'media',
        prompt,
        shape,
        seconds: secondsAsked,
        photoKey: d.photoKey ?? null,
        audioKey: d.audioKey ?? null,
        sourceJobId: d.sourceJobId ?? null,
        // Set by the tool's precheck from the settings, and by the Hub when it opens the files.
        model: '',
        resolution: '',
        withSound: false,
        photo: null,
        speech: null,
      },
      voiceId: '',
      same: [
        shape,
        secondsAsked,
        d.photoKey ?? null,
        d.audioKey ?? null,
        d.sourceJobId ?? null,
      ],
      hashText: prompt,
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
