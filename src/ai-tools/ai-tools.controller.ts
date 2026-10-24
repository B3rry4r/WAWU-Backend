import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader } from '@nestjs/swagger';
import type { Response } from 'express';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { BuiltBy } from '../money/money-contract';
import { AiJobService } from './ai-job.service';
import {
  AiJobListQueryDto,
  CreateCaptionsJobDto,
  CreateCleanAudioJobDto,
  CreateMusicJobDto,
  CreateQuickVoiceJobDto,
  CreateSoundEffectJobDto,
  CreateVoiceoverJobDto,
  QuoteFileDto,
} from './ai-tools.dto';
import { AiToolsService } from './ai-tools.service';
import type {
  AiFileQuoteView,
  AiJobPage,
  AiJobView,
  AiToolsView,
} from './ai-tools-view.type';
import { CAPTIONS_TOOL } from './tools/captions.tool';
import { CLEAN_AUDIO_TOOL } from './tools/clean-audio.tool';
import { MUSIC_TOOL } from './tools/music.tool';
import { QUICK_VOICE_TOOL } from './tools/quick-voice.tool';
import { SOUND_EFFECT_TOOL } from './tools/sound-effect.tool';

/**
 * The AI tools (AITOOLS-01, AITOOLS-02, R-43, R-61, R-78, PT1 and PT2). Every
 * tool runs through the one job pipeline (`AiJobService.createJob`); the
 * points a job costs are held, kept or given back by POINTS-03; no route here
 * moves naira.
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('ai-tools')
export class AiToolsController {
  constructor(
    private readonly tools: AiToolsService,
    private readonly jobs: AiJobService,
  ) {}

  /**
   * The tools the Hub can run, each with its points per unit, whether it is
   * on, its limits and its voices, and the caps that stop a job (PT1, PT7).
   * Costs and caps are settings. Read-only.
   */
  @Get()
  @Header('Cache-Control', 'no-store')
  @BuiltBy('AITOOLS-01')
  list(): AiToolsView {
    return this.tools.list();
  }

  /**
   * Starts a VoiceOver job (PT2): `text`, a `voiceId` from the list and the
   * `quoteToken` of the `POST /points/quote` the person saw. Holds the job's
   * points, answers `202` with the job `working` and makes the audio after the
   * answer; `GET /ai-tools/jobs/{id}` is what the app polls. The points are
   * kept only when the audio is made and given back when it is not.
   *
   * Needs an `Idempotency-Key` (8 to 128 of `[A-Za-z0-9_-]`): the same key and
   * words again answer the first job (`200`, `Idempotent-Replayed: true`)
   * and hold nothing more; the same key with other words is `409
   * idempotency_key_reused`. Refused with nothing held: `422
   * points_cap_reached` naming the cap (characters, minutes or the day's
   * points), `402 insufficient_points`, `409 quote_changed` (the cost is not
   * what the quote showed), `400 ai_voice_unknown`, `503 ai_tool_unavailable`.
   * A refusal leaves the key free to use once the cause is fixed.
   */
  @Post('voiceover/jobs')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8 to 128 of letters, digits, - or _: one per job.',
  })
  @BuiltBy('AITOOLS-01')
  async createVoiceover(
    @CurrentUser() user: WawuJwtClaims,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: CreateVoiceoverJobDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AiJobView> {
    const { job, replayed } = await this.jobs.createVoiceover(
      user.sub,
      key,
      dto,
    );
    if (replayed) {
      res.status(200);
      res.setHeader('Idempotent-Replayed', 'true');
    }
    return job;
  }

  /**
   * Starts a Quick voice job (PT1 "Quick voice", AITOOLS-02): a fast read of
   * the words in one of the same voices as VoiceOver, priced by
   * `quick_voice_per_min`. The request, the answer, the `Idempotency-Key`
   * rule and every refusal are exactly those of `POST /ai-tools/voiceover/jobs`;
   * the `quoteToken` is one for the action `quick_voice_per_min`.
   */
  @Post('quick-voice/jobs')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8 to 128 of letters, digits, - or _: one per job.',
  })
  @BuiltBy('AITOOLS-02')
  async createQuickVoice(
    @CurrentUser() user: WawuJwtClaims,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: CreateQuickVoiceJobDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AiJobView> {
    const { job, replayed } = await this.jobs.createJob(
      QUICK_VOICE_TOOL,
      user.sub,
      key,
      dto,
    );
    if (replayed) {
      res.status(200);
      res.setHeader('Idempotent-Replayed', 'true');
    }
    return job;
  }

  /**
   * Starts a Sound effect job (PT1 "Sound effect", AITOOLS-03): a `prompt`
   * describing the sound, an optional `durationSeconds` and the `quoteToken`
   * of the `POST /points/quote` for the action `sfx`. Priced flat, one use,
   * whatever the length. The request, the answer, the `Idempotency-Key` rule
   * and the refusals are those of `POST /ai-tools/voiceover/jobs`, plus
   * `422 ai_prompt_too_long` and `422 ai_length_too_long`, each naming its
   * limit, and `400 ai_prompt_empty`. Nothing is held when a job is refused.
   */
  @Post('sound-effect/jobs')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8 to 128 of letters, digits, - or _: one per job.',
  })
  @BuiltBy('AITOOLS-03')
  async createSoundEffect(
    @CurrentUser() user: WawuJwtClaims,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: CreateSoundEffectJobDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AiJobView> {
    const { job, replayed } = await this.jobs.createJob(
      SOUND_EFFECT_TOOL,
      user.sub,
      key,
      dto,
    );
    if (replayed) {
      res.status(200);
      res.setHeader('Idempotent-Replayed', 'true');
    }
    return job;
  }

  /**
   * Starts a Music track job (PT1 "Music track", AITOOLS-03): a `prompt`
   * describing the track, an optional `lengthSeconds`, an optional
   * `instrumental` switch and the `quoteToken` of the `POST /points/quote`
   * for the action `music_per_track`. Priced flat, one track, whatever the
   * length. A track can take minutes to make, so the app polls `GET
   * /ai-tools/jobs/{id}`. The request, the answer, the `Idempotency-Key` rule
   * and the refusals are those of `POST /ai-tools/sound-effect/jobs`.
   */
  @Post('music/jobs')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8 to 128 of letters, digits, - or _: one per job.',
  })
  @BuiltBy('AITOOLS-03')
  async createMusic(
    @CurrentUser() user: WawuJwtClaims,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: CreateMusicJobDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AiJobView> {
    const { job, replayed } = await this.jobs.createJob(
      MUSIC_TOOL,
      user.sub,
      key,
      dto,
    );
    if (replayed) {
      res.status(200);
      res.setHeader('Idempotent-Replayed', 'true');
    }
    return job;
  }

  /**
   * The points quote for a Captions file (AITOOLS-04): the `fileKey` of a file
   * the person uploaded. The Hub reads the file's length itself and prices the
   * minutes from that, so the phone sends no length. Answers the same quote
   * `POST /points/quote` does (with its `quoteToken`, to send to the job route
   * with the same `fileKey`), plus `file.seconds` and `file.minutes`. Nothing
   * is held. `404 not_found` (not the caller's own file), `422 ai_file_too_large`,
   * `422 ai_file_unreadable`; over the longest job the quote's `cap` names
   * `minutes_per_job` and `canRun` is false.
   */
  @Post('captions/quote')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @BuiltBy('AITOOLS-04')
  quoteCaptions(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: QuoteFileDto,
  ): Promise<AiFileQuoteView> {
    return this.tools.quoteFile(user.sub, CAPTIONS_TOOL, dto.fileKey);
  }

  /** The points quote for a Clean audio file (AITOOLS-04): exactly `POST /ai-tools/captions/quote`, for the action `clean_audio_per_min`. */
  @Post('clean-audio/quote')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @BuiltBy('AITOOLS-04')
  quoteCleanAudio(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: QuoteFileDto,
  ): Promise<AiFileQuoteView> {
    return this.tools.quoteFile(user.sub, CLEAN_AUDIO_TOOL, dto.fileKey);
  }

  /**
   * Starts a Captions job (PT1 "Captions", AITOOLS-04): the `fileKey` of a
   * recording or video the person uploaded (`POST /uploads/presign`, folder
   * `ai/input-audio` or `ai/input-video`, then `POST /uploads/confirm`), an
   * optional `languageCode` and the `quoteToken` of the `POST /points/quote`
   * (sent with the same `fileKey`) for the action `captions_per_min`. Priced by
   * the minute of the file, as the Hub reads it from the file itself (rounded
   * up, at least 1). The done job's `outputs` hold the words (`text`) and a
   * subtitle file (`subtitles`, SRT). The request, the answer and the
   * `Idempotency-Key` rule are those of `POST /ai-tools/voiceover/jobs`, plus
   * `404 not_found` (not the caller's own file), `422 ai_file_too_large` and
   * `422 ai_file_unreadable`, each with nothing held; over the longest job the
   * answer is `422 points_cap_reached` naming `minutes_per_job`. The uploaded
   * file is deleted when the job ends, either way.
   */
  @Post('captions/jobs')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8 to 128 of letters, digits, - or _: one per job.',
  })
  @BuiltBy('AITOOLS-04')
  async createCaptions(
    @CurrentUser() user: WawuJwtClaims,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: CreateCaptionsJobDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AiJobView> {
    const { job, replayed } = await this.jobs.createJob(
      CAPTIONS_TOOL,
      user.sub,
      key,
      dto,
    );
    if (replayed) {
      res.status(200);
      res.setHeader('Idempotent-Replayed', 'true');
    }
    return job;
  }

  /**
   * Starts a Clean audio job (PT1 "Clean audio", AITOOLS-04): the `fileKey` of
   * a recording or video the person uploaded and the `quoteToken` for the
   * action `clean_audio_per_min`. The done job's `audioUrl` (and its `audio`
   * output) is the same recording with the noise taken out. The request, the
   * answer and every refusal are those of `POST /ai-tools/captions/jobs`.
   */
  @Post('clean-audio/jobs')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8 to 128 of letters, digits, - or _: one per job.',
  })
  @BuiltBy('AITOOLS-04')
  async createCleanAudio(
    @CurrentUser() user: WawuJwtClaims,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: CreateCleanAudioJobDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AiJobView> {
    const { job, replayed } = await this.jobs.createJob(
      CLEAN_AUDIO_TOOL,
      user.sub,
      key,
      dto,
    );
    if (replayed) {
      res.status(200);
      res.setHeader('Idempotent-Replayed', 'true');
    }
    return job;
  }

  /**
   * The caller's own jobs of every tool, newest first, in cursor pages
   * (`?cursor&limit`, `{ items, nextCursor }`; CONVENTIONS section 6). Each
   * item is the same shape as `GET /ai-tools/jobs/{id}`: the tool, the state,
   * the points taken, the times and its outputs. A cursor this list did not
   * give is a plain `400`.
   */
  @Get('jobs')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('AITOOLS-02')
  listJobs(
    @CurrentUser() user: WawuJwtClaims,
    @Query() query: AiJobListQueryDto,
  ): Promise<AiJobPage> {
    return this.jobs.list(user.sub, query);
  }

  /**
   * One job as it stands now: `working`, `done` with `audioUrl` and its
   * `outputs`, or `failed` with the words "No points were taken" (PT2c). Only
   * the person who ran it reads it; another person's job and one that is not
   * there are the same `404 not_found`.
   */
  @Get('jobs/:id')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('AITOOLS-01')
  readJob(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AiJobView> {
    return this.jobs.read(user.sub, id);
  }
}
