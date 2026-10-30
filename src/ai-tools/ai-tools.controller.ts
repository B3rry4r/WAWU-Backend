import {
  Body,
  Controller,
  Delete,
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
  OwnVoiceConsentDto,
  CreateAudiobookJobDto,
  CreateCaptionsJobDto,
  CreateCleanAudioJobDto,
  CreateDialogueJobDto,
  CreateDubbingJobDto,
  CreateImageJobDto,
  CreateMusicJobDto,
  CreateMyVoiceJobDto,
  CreatePhotoEditJobDto,
  CreatePodcastJobDto,
  CreateQuickVoiceJobDto,
  CreateSoundEffectJobDto,
  CreateStemsJobDto,
  CreateTalkingPhotoJobDto,
  CreateVideoJobDto,
  CreateVideoMusicJobDto,
  CreateVoiceChangerJobDto,
  CreateVoiceoverJobDto,
  QuoteFileDto,
  QuoteTalkingPhotoDto,
} from './ai-tools.dto';
import { AiToolsService } from './ai-tools.service';
import type {
  AiFileQuoteView,
  AiJobPage,
  AiJobView,
  AiSpeechQuoteView,
  AiToolsView,
  SavedVoiceRemovedView,
  SavedVoiceView,
  OwnVoiceRemovedView,
  OwnVoiceView,
} from './ai-tools-view.type';
import { AiCloneService } from './own-voice/ai-clone.service';
import { OwnVoiceService } from './own-voice/own-voice.service';
import { personName } from '../voice-intro/voice-profile.service';
import { CAPTIONS_TOOL } from './tools/captions.tool';
import { CLEAN_AUDIO_TOOL } from './tools/clean-audio.tool';
import { DIALOGUE_TOOL } from './tools/dialogue.tool';
import { MY_VOICE_TOOL } from './tools/my-voice.tool';
import { STEMS_TOOL } from './tools/stems.tool';
import { VIDEO_MUSIC_TOOL } from './tools/video-music.tool';
import { VOICE_CHANGER_TOOL } from './tools/voice-changer.tool';
import { AUDIOBOOK_TOOL } from './tools/audiobook.tool';
import { PODCAST_TOOL } from './tools/podcast.tool';
import { DUBBING_TOOL } from './tools/dubbing.tool';
import { IMAGE_TOOL } from './tools/image.tool';
import { MUSIC_TOOL } from './tools/music.tool';
import { PHOTO_EDIT_TOOL } from './tools/photo-edit.tool';
import { QUICK_VOICE_TOOL } from './tools/quick-voice.tool';
import { SOUND_EFFECT_TOOL } from './tools/sound-effect.tool';
import { TALKING_PHOTO_TOOL } from './tools/talking-photo.tool';
import { VIDEO_TOOL } from './tools/video.tool';

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
    private readonly own: OwnVoiceService,
    private readonly clones: AiCloneService,
  ) {}

  /**
   * The tools the Hub can run, each with its points per unit, whether it is
   * on, its limits and its voices, and the caps that stop a job (PT1, PT7).
   * Costs and caps are settings. Read-only.
   */
  @Get()
  @Header('Cache-Control', 'no-store')
  @BuiltBy('AITOOLS-01')
  list(@CurrentUser() user: WawuJwtClaims): Promise<AiToolsView> {
    // AITOOLS-11: the person's own saved voice joins the voices of the tools that speak, for its owner only.
    return this.tools.list(user.sub);
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
   * The points quote for a Dubbing file (AITOOLS-05): exactly `POST
   * /ai-tools/captions/quote`, for the action `dub_standard_per_min_lang`. The
   * price is the minutes of the file the Hub reads, for one language.
   */
  @Post('dubbing/quote')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @BuiltBy('AITOOLS-05')
  quoteDubbing(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: QuoteFileDto,
  ): Promise<AiFileQuoteView> {
    return this.tools.quoteFile(user.sub, DUBBING_TOOL, dto.fileKey);
  }

  /**
   * Starts a Dubbing job (PT1 "Dubbing", AITOOLS-05): the `fileKey` of a
   * recording or video the person uploaded, the `targetLanguage` to hear it in
   * (a code from `GET /ai-tools`, `input.file.dubbing.languages`), an optional
   * `sourceLanguage` and the `quoteToken` of the quote for the action
   * `dub_standard_per_min_lang`. One language a job: a second language is a second
   * job. The points are held and the job answers `working` at once; a dub takes
   * minutes, so the person may leave and the app reads `GET /ai-tools/jobs/{id}`
   * later. Done, `outputs` hold the dubbed audio (`audio`, FLAC) and the subtitles
   * (`subtitles`, WebVTT); there is no dubbed video, so a video comes back as
   * audio. The points are kept only on success and given back when the provider
   * fails the dub, it stays too long, or the result cannot be stored. The
   * request, the answer and the `Idempotency-Key` rule are those of `POST
   * /ai-tools/captions/jobs`, plus `422 ai_language_unsupported` (a language not
   * on the list, or the same language as the one spoken), with nothing held. The
   * uploaded file and the provider's project are deleted when the job ends.
   */
  @Post('dubbing/jobs')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8 to 128 of letters, digits, - or _: one per job.',
  })
  @BuiltBy('AITOOLS-05')
  async createDubbing(
    @CurrentUser() user: WawuJwtClaims,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: CreateDubbingJobDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AiJobView> {
    const { job, replayed } = await this.jobs.createJob(
      DUBBING_TOOL,
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
   * Starts a Make an image job (AITOOLS-09, R-109): a `prompt`, an optional
   * `shape` (one of `input.options.shapes` from `GET /ai-tools`) and the
   * `quoteToken` of the `POST /points/quote` for the action `image_per_use`
   * (units 1). Priced flat, one picture. The points are held and the job
   * answers `202 working` at once; the picture is made in the background, so
   * the app polls `GET /ai-tools/jobs/{id}` and may leave. Done, `outputs` hold
   * the picture (`kind: image`, with `contentType`, `bytes`, `name`,
   * `downloadUrl` and `pieceFormat: image`). The points are kept only on
   * success; a refused or failed picture gives every point back with the Hub's
   * own sentence. The request, the answer and the `Idempotency-Key` rule are
   * those of `POST /ai-tools/sound-effect/jobs`, plus `422 ai_shape_unsupported`.
   * The tool is listed, and the route answers, only while its switch
   * `ai.listed.image` is on.
   */
  @Post('image/jobs')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8 to 128 of letters, digits, - or _: one per job.',
  })
  @BuiltBy('AITOOLS-09')
  async createImage(
    @CurrentUser() user: WawuJwtClaims,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: CreateImageJobDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AiJobView> {
    const { job, replayed } = await this.jobs.createJob(
      IMAGE_TOOL,
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
   * Starts an Edit a photo job (AITOOLS-09, R-109): the same body as Make an
   * image plus the `photoKey` of the person's own photo (`POST /uploads/presign`
   * with the folder `ai/input-image`, then `POST /uploads/confirm`; a JPEG, PNG
   * or WebP picture up to 25 MB). The quote is for the action
   * `photo_edit_per_use`. Another person's key is `404 not_found`; a file the
   * Hub cannot open as a picture is `422 ai_photo_unreadable`; each with nothing
   * held. The photo is deleted when the job ends, and the provider's copy of it
   * too.
   */
  @Post('photo-edit/jobs')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8 to 128 of letters, digits, - or _: one per job.',
  })
  @BuiltBy('AITOOLS-09')
  async createPhotoEdit(
    @CurrentUser() user: WawuJwtClaims,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: CreatePhotoEditJobDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AiJobView> {
    const { job, replayed } = await this.jobs.createJob(
      PHOTO_EDIT_TOOL,
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
   * Starts a Make a video job (AITOOLS-10, R-109): a `prompt`, an optional
   * `shape` (wide or tall), the clip's `seconds` (one of `input.options.lengths`:
   * 4, 6 or 8), an optional `photoKey` to start from and the `quoteToken` of the
   * `POST /points/quote` for the action `video_per_sec` (units = `seconds`).
   * Priced by the second. A clip takes minutes: the job answers `202 working`,
   * the app polls `GET /ai-tools/jobs/{id}`, and a job that ran long writes an
   * `ai_job_ready` notification when it ends. Done, `outputs` hold the clip
   * (`kind: video`, `pieceFormat: video`). The request, the answer and the
   * refusals are those of `POST /ai-tools/photo-edit/jobs`, plus
   * `422 ai_length_unsupported`.
   */
  @Post('video/jobs')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8 to 128 of letters, digits, - or _: one per job.',
  })
  @BuiltBy('AITOOLS-10')
  async createVideo(
    @CurrentUser() user: WawuJwtClaims,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: CreateVideoJobDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AiJobView> {
    const { job, replayed } = await this.jobs.createJob(
      VIDEO_TOOL,
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
   * The points quote for a Talking photo's voice (AITOOLS-10): the `audioKey` of
   * a recording the person uploaded (`ai/input-audio`, MP3 or WAV) or the
   * `sourceJobId` of one of their own finished voice results. The Hub reads the
   * voice's length itself and prices the seconds from that, so the phone sends no
   * length. Answers the same quote `POST /points/quote` does (with its
   * `quoteToken`, to send to the job route with the same voice), plus
   * `speech.seconds`. Nothing is held. `404 not_found`, `409 job_not_ready`,
   * `422 ai_speech_unreadable`, `422 ai_length_too_long` over the setting.
   */
  @Post('talking-photo/quote')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @BuiltBy('AITOOLS-10')
  async quoteTalkingPhoto(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: QuoteTalkingPhotoDto,
  ): Promise<AiSpeechQuoteView> {
    const speech = await this.jobs.openSpeech(user.sub, dto);
    return this.tools.quoteSpeech(user.sub, TALKING_PHOTO_TOOL, speech.seconds);
  }

  /**
   * Starts a Talking photo job (AITOOLS-10, R-109): the `photoKey` of the
   * person's photo and exactly one voice, an `audioKey` or a `sourceJobId`, with
   * the `quoteToken` from `POST /ai-tools/talking-photo/quote` for the same
   * voice. Priced by the seconds of speech the Hub read; a voice longer than
   * `input.options.speech.maxSeconds` is `422 ai_length_too_long`, with nothing
   * held. The photo and the recording are deleted when the job ends, and the
   * provider's copies too. The request, the answer and the other refusals are
   * those of `POST /ai-tools/video/jobs`.
   */
  @Post('talking-photo/jobs')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8 to 128 of letters, digits, - or _: one per job.',
  })
  @BuiltBy('AITOOLS-10')
  async createTalkingPhoto(
    @CurrentUser() user: WawuJwtClaims,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: CreateTalkingPhotoJobDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AiJobView> {
    const { job, replayed } = await this.jobs.createJob(
      TALKING_PHOTO_TOOL,
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
   * The points quote for a Voice changer recording (AITOOLS-11, R-109): exactly `POST /ai-tools/captions/quote`, for the
   * action `voice_changer_per_min`. The Hub reads the recording's length itself. A video, or a file it cannot read, is
   * refused with nothing held. `503 ai_tool_unavailable` while the tool's switch `ai.listed.voice-changer` is off.
   */
  @Post('voice-changer/quote')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @BuiltBy('AITOOLS-11')
  quoteVoiceChanger(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: QuoteFileDto,
  ): Promise<AiFileQuoteView> {
    return this.tools.quoteFile(user.sub, VOICE_CHANGER_TOOL, dto.fileKey);
  }

  /**
   * Starts a Voice changer job (AITOOLS-11, R-109): the `fileKey` of a recording the person uploaded (`ai/input-audio`),
   * the `voiceId` to hear it in (a voice from `GET /ai-tools`, or `own` for their saved voice) and the `quoteToken`
   * for the action `voice_changer_per_min`. The same words, timing and feeling come back in the new voice: the done
   * job's `audioUrl` and its `audio` output (`pieceFormat: audio`). Priced by the minute of the recording as the Hub
   * reads it. The request, the answer and every refusal are those of `POST /ai-tools/captions/jobs`, plus
   * `400 ai_voice_unknown`. The recording is deleted when the job ends.
   */
  @Post('voice-changer/jobs')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8 to 128 of letters, digits, - or _: one per job.',
  })
  @BuiltBy('AITOOLS-11')
  async createVoiceChanger(
    @CurrentUser() user: WawuJwtClaims,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: CreateVoiceChangerJobDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AiJobView> {
    const { job, replayed } = await this.jobs.createJob(
      VOICE_CHANGER_TOOL,
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
   * Starts a Dialogue job (AITOOLS-11, R-109): `lines`, each `{ text, voiceId }` (a voice from `GET /ai-tools`, or `own`
   * for the person's saved voice), and the `quoteToken` of the `POST /points/quote` for the action `dialogue_per_min`
   * (units = the minutes the characters make, `characters` the total). At most 10 different voices and the character
   * limit in `GET /ai-tools` (`input.maxCharacters`); an empty line, too many voices, too many characters or a voice not on
   * the person's list is refused with the reason and nothing held. The done job's `audioUrl` is the whole scene.
   */
  @Post('dialogue/jobs')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8 to 128 of letters, digits, - or _: one per job.',
  })
  @BuiltBy('AITOOLS-11')
  async createDialogue(
    @CurrentUser() user: WawuJwtClaims,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: CreateDialogueJobDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AiJobView> {
    const { job, replayed } = await this.jobs.createJob(
      DIALOGUE_TOOL,
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
   * "Clone your own voice" (AITOOLS-11, R-109): whether the person keeps a clone of their voice (`state`: `none`,
   * `making`, `ready`), its name, the words they agree to (`consent.line`, with their own name) and what the recording
   * must be. Read-only. `available` is false while the tool's switch `ai.listed.my-voice` is off.
   */
  @Get('my-voice')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('AITOOLS-11')
  myVoice(@CurrentUser() user: WawuJwtClaims): Promise<SavedVoiceView> {
    return this.clones.view(user.sub, personName(user));
  }

  /** The points quote for the recording a clone is made from (AITOOLS-11): exactly `POST /ai-tools/captions/quote`, priced once (units 1), for the action `voice_clone_once`. A recording that is too short or too long is refused here. */
  @Post('my-voice/quote')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @BuiltBy('AITOOLS-11')
  quoteMyVoice(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: QuoteFileDto,
  ): Promise<AiFileQuoteView> {
    return this.tools.quoteFile(user.sub, MY_VOICE_TOOL, dto.fileKey);
  }

  /**
   * Makes the clone (AITOOLS-11, R-109): the `fileKey` of the person's own recording (`ai/input-audio`), a `name` for
   * the voice, the `consentLine` they agreed to (`consent.line` from `GET /ai-tools/my-voice`, sent back unchanged) and
   * the `quoteToken` for the action `voice_clone_once`. One clone a person: a second is `409 clone_exists` with nothing
   * held, and two taps at once make one. The points are held and the job answers `202 working`; poll `GET
   * /ai-tools/jobs/{id}` and `GET /ai-tools/my-voice`. Done, "Your voice" (`own`) is a choice in the voice tools for
   * its owner only. The points are kept only when the clone is made. The recording is deleted when the job ends.
   * Refusals with nothing held: `409 own_voice_consent_line_changed`, `409 own_voice_name_required`, `422
   * ai_length_too_short`, `422 ai_length_too_long`, `422 ai_file_unreadable`.
   */
  @Post('my-voice')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8 to 128 of letters, digits, - or _: one per job.',
  })
  @BuiltBy('AITOOLS-11')
  async createMyVoice(
    @CurrentUser() user: WawuJwtClaims,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: CreateMyVoiceJobDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AiJobView> {
    // The words agreed to are the ones the Hub served for THIS person, with their own name.
    this.clones.assertConsent(personName(user), dto.consentLine);
    const { job, replayed } = await this.jobs.createJob(
      MY_VOICE_TOOL,
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
   * Removes the person's saved voice (AITOOLS-11): "Your voice" leaves every list at once, the agreement goes with it
   * and the Hub deletes the provider's copy. Always works (also while the tool's switch is off). `gone`: the provider
   * holds none; `pending`: the Hub is still removing it and keeps trying. Nothing is charged or given back.
   */
  @Delete('my-voice')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('AITOOLS-11')
  async removeMyVoice(
    @CurrentUser() user: WawuJwtClaims,
  ): Promise<SavedVoiceRemovedView> {
    const atProvider = await this.clones.remove(user.sub);
    return {
      myVoice: await this.clones.view(user.sub, personName(user)),
      atProvider,
    };
  }

  /** The points quote for the video Music for a video is made for (AITOOLS-12, R-109): exactly `POST /ai-tools/captions/quote`, priced flat (units 1), for the action `video_music_per_track`. An audio file, a video over the length setting or over 200 MB is refused here. */
  @Post('video-music/quote')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @BuiltBy('AITOOLS-12')
  quoteVideoMusic(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: QuoteFileDto,
  ): Promise<AiFileQuoteView> {
    return this.tools.quoteFile(user.sub, VIDEO_MUSIC_TOOL, dto.fileKey);
  }

  /**
   * Starts a Music for a video job (AITOOLS-12, R-109): the `fileKey` of the person's own video (`ai/input-video`), an
   * optional `description` (the mood in words) and the `quoteToken` for the action `video_music_per_track`. Priced flat,
   * one track. The result is MUSIC as an audio file: the Hub does not put it on the video (the provider returns music
   * only), and the screen says so. A long job: the app polls `GET /ai-tools/jobs/{id}`. The request, the answer and
   * the refusals are those of `POST /ai-tools/captions/jobs`, plus `422 ai_length_too_long`, `422 ai_file_too_large` and
   * `422 ai_prompt_too_long`. If the provider's plan does not cover the route the job fails with "This isn't available
   * right now. No points were taken." The video is deleted when the job ends.
   */
  @Post('video-music/jobs')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8 to 128 of letters, digits, - or _: one per job.',
  })
  @BuiltBy('AITOOLS-12')
  async createVideoMusic(
    @CurrentUser() user: WawuJwtClaims,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: CreateVideoMusicJobDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AiJobView> {
    const { job, replayed } = await this.jobs.createJob(
      VIDEO_MUSIC_TOOL,
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

  /** The points quote for the song Split a song takes (AITOOLS-12, R-109): exactly `POST /ai-tools/captions/quote`, priced flat (units 1), for the action `stems_per_song`. */
  @Post('stems/quote')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @BuiltBy('AITOOLS-12')
  quoteStems(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: QuoteFileDto,
  ): Promise<AiFileQuoteView> {
    return this.tools.quoteFile(user.sub, STEMS_TOOL, dto.fileKey);
  }

  /**
   * Starts a Split a song job (AITOOLS-12, R-109): the `fileKey` of the person's own song (`ai/input-audio`), `parts`
   * (2: the voice and the rest, or 6; left out: 2) and the `quoteToken` for the action `stems_per_song`. Priced flat,
   * one song. Done, `outputs` hold one `audio` file for each part with its plain `name` ("Voice", "Drums"), each with
   * `pieceFormat: audio`; `POST /ai-tools/jobs/{id}/piece` takes the `outputIndex` of the part the person picks. A long
   * job: the app polls `GET /ai-tools/jobs/{id}`. The request, the answer and the refusals are those of `POST
   * /ai-tools/video-music/jobs`. An answer from the provider the Hub cannot open safely fails the job and gives every
   * point back. The song is deleted when the job ends.
   */
  @Post('stems/jobs')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8 to 128 of letters, digits, - or _: one per job.',
  })
  @BuiltBy('AITOOLS-12')
  async createStems(
    @CurrentUser() user: WawuJwtClaims,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: CreateStemsJobDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AiJobView> {
    const { job, replayed } = await this.jobs.createJob(
      STEMS_TOOL,
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
   * Starts an Audiobook job (AITOOLS-13, R-109): the `text` (or the `fileKey` of a plain text file uploaded to
   * `ai/input-doc`), a `voiceId` from `GET /ai-tools` and the `quoteToken` for the action `audiobook_per_min` (units = the
   * minutes the characters make, `characters` the total). The points for the whole text are held up front; the Hub speaks
   * the chapters one after the other and joins them into one audio file: poll `GET /ai-tools/jobs/{id}`; the done job's
   * `audioUrl` is the whole book (`pieceFormat: audio`, one piece). An empty text, a text over the limit in `GET
   * /ai-tools` (`input.maxCharacters`), a voice off the list and a file that is not text are refused with the reason and
   * nothing held; the day's cap stops a longer book (`points_cap_reached`, with the reset time). `503
   * ai_tool_unavailable` while the tool's switch `ai.listed.audiobook` is off.
   */
  @Post('audiobook/jobs')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8 to 128 of letters, digits, - or _: one per job.',
  })
  @BuiltBy('AITOOLS-13')
  async createAudiobook(
    @CurrentUser() user: WawuJwtClaims,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: CreateAudiobookJobDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AiJobView> {
    const { job, replayed } = await this.jobs.createJob(
      AUDIOBOOK_TOOL,
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
   * Starts a Podcast maker job (AITOOLS-13, R-109): a `source` (`text`, or an `https` `url` of at most 2,000 characters,
   * which the Hub never opens), a `mode` (`conversation` with two `voiceIds`, `bulletin` with one), a `duration` (`short`,
   * `standard` or `long`, each its own plan action: the `quoteToken` is for that action, units 1) and a `language` from
   * `GET /ai-tools` (`input.podcast.languages`). The provider works for minutes: poll `GET /ai-tools/jobs/{id}`; the done
   * job's `audioUrl` is the podcast (`pieceFormat: audio`). A link that is not `https`, one over the limit, two voices that
   * are the same and a language off the list are refused with the reason and nothing held. If the provider does not take
   * our account (its Studio API is open to allowlisted accounts only) the job fails with "This isn't available right now.
   * No points were taken." The tool is listed only while `ai.listed.podcast` and `ai.podcast_studio_api_ok` are both on.
   */
  @Post('podcast/jobs')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8 to 128 of letters, digits, - or _: one per job.',
  })
  @BuiltBy('AITOOLS-13')
  async createPodcast(
    @CurrentUser() user: WawuJwtClaims,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: CreatePodcastJobDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AiJobView> {
    const { job, replayed } = await this.jobs.createJob(
      PODCAST_TOOL,
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
  /**
   * Saves a finished result to the person's library (PT2b "Save", AITOOLS-07).
   * Only the person's own finished job: another person's job and one that is
   * not there are the same `404 not_found`, one still working or failed is
   * `409 job_not_ready`. Saving twice keeps the first time and answers the job
   * again. The job reads `saved: true`; `GET /ai-tools/jobs?saved=true` lists
   * the saved results.
   */
  @Post('jobs/:id/save')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @BuiltBy('AITOOLS-07')
  saveJob(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AiJobView> {
    return this.jobs.setSaved(user.sub, id, true);
  }

  /** Takes a result out of the library again (`saved: false`). The result itself stays on the job. */
  @Delete('jobs/:id/save')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('AITOOLS-07')
  unsaveJob(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AiJobView> {
    return this.jobs.setSaved(user.sub, id, false);
  }

  /**
   * "Your voice" on PT2 (AITOOLS-07): whether the person's own voice can read
   * their VoiceOver, and the words they agree to first. It is made from the
   * recording of their Voice Intro and nothing else. `ready` is true when the
   * tools are on, the recording is there and they agreed; then a VoiceOver job
   * may name the voice `own`.
   */
  @Get('own-voice')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('AITOOLS-07')
  ownVoice(@CurrentUser() user: WawuJwtClaims): Promise<OwnVoiceView> {
    return this.own.view(user.sub, personName(user));
  }

  /**
   * The person agrees to the words the Hub served in `consent.line`, sent back
   * unchanged. Stored exactly, with the time. `409 own_voice_consent_line_changed`
   * for any other words, `409 own_voice_recording_required` before the Voice
   * Intro recording, `409 own_voice_name_required` with no name on the account.
   */
  @Post('own-voice/consent')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @BuiltBy('AITOOLS-07')
  giveOwnVoiceConsent(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: OwnVoiceConsentDto,
  ): Promise<OwnVoiceView> {
    return this.own.giveConsent(user.sub, personName(user), dto.line);
  }

  /**
   * Takes the agreement back and has the provider drop every copy of the
   * person's voice it still holds. The answer says whether the provider holds
   * none (`gone`) or the Hub is still removing one (`pending`, it keeps trying).
   * The Voice Intro and its recording stay. Nothing is charged.
   */
  @Delete('own-voice')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('AITOOLS-07')
  removeOwnVoice(
    @CurrentUser() user: WawuJwtClaims,
  ): Promise<OwnVoiceRemovedView> {
    return this.own.remove(user.sub, personName(user));
  }
}
