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
  Put,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader } from '@nestjs/swagger';
import type { Response } from 'express';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { BuiltBy } from '../money/money-contract';
import {
  NamePreviewDto,
  SaveNameDto,
  VoiceConsentDto,
  VoiceIntroTextDto,
  VoiceSampleDto,
} from './voice-intro.dto';
import { VoiceIntroRunService } from './voice-intro-run.service';
import { VoiceProfileService } from './voice-profile.service';
import type {
  MyVoiceView,
  NamePreviewView,
  PublicVoiceIntroView,
  VoiceIntroView,
} from './voice-intro-view.type';

/**
 * The caller's own voice (VOICE-01, R-43, R-66, VF3 to VF11): how their name
 * is said and their Voice Intro in their own AI voice. No route takes an id:
 * there is no way to ask for, record or use anyone else's voice. Audio is an
 * AI voice and says so (`aiVoice: true`). The points a Voice Intro costs are
 * held, kept or given back by POINTS-03; no route here moves naira.
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('me')
export class VoiceIntroController {
  constructor(
    private readonly profiles: VoiceProfileService,
    private readonly runs: VoiceIntroRunService,
  ) {}

  /** How the caller's name is said, and whether voices are on. */
  @Get('voice')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('VOICE-01')
  mine(@CurrentUser() user: WawuJwtClaims): Promise<MyVoiceView> {
    return this.profiles.mine(user.sub);
  }

  /**
   * "Hear your name" (VF3): the name, said in the studio voice. Free; limited
   * per hour by a setting (`429 voice_preview_limit`). `phonetic` is how it
   * sounds when the plain spelling is not said right. `503 voice_unavailable`
   * when voices are not set up on the Hub.
   */
  @Post('voice/name-preview')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @BuiltBy('VOICE-01')
  previewName(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: NamePreviewDto,
  ): Promise<NamePreviewView> {
    return this.profiles.previewName(user.sub, dto);
  }

  /** Keeps how the caller's name is said (`null` puts it back to the plain name). */
  @Put('voice/name')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('VOICE-01')
  saveName(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: SaveNameDto,
  ): Promise<MyVoiceView> {
    return this.profiles.saveName(user.sub, dto.phonetic);
  }

  /**
   * The Voice Intro as it stands: the words, the consent line to show and
   * whether it is given, whether a sample is in, the audio (`aiVoice: true`),
   * what the next try costs (free when the tier still includes the first one)
   * and the latest try.
   */
  @Get('voice-intro')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('VOICE-01')
  intro(@CurrentUser() user: WawuJwtClaims): Promise<VoiceIntroView> {
    return this.runs.view(user.sub);
  }

  /** The words of the Voice Intro. Up to `textMaxChars` (a setting): `400 voice_text_too_long` over it. */
  @Put('voice-intro/text')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('VOICE-01')
  async saveText(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: VoiceIntroTextDto,
  ): Promise<VoiceIntroView> {
    await this.profiles.saveText(user.sub, dto.text);
    return this.runs.view(user.sub);
  }

  /**
   * The caller agrees that this is their own voice. `line` must be the words
   * `GET /me/voice-intro` served (`409 voice_consent_line_changed` otherwise);
   * they are stored with the time.
   */
  @Post('voice-intro/consent')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @BuiltBy('VOICE-01')
  async consent(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: VoiceConsentDto,
  ): Promise<VoiceIntroView> {
    await this.profiles.giveConsent(user.sub, dto.line);
    return this.runs.view(user.sub);
  }

  /**
   * Keeps the 30 second recording the caller uploaded: `POST /uploads/presign`
   * with the folder `voice/sample`, the file sent, `POST /uploads/confirm`,
   * then the `fileUrl` here. Only the caller's own landed upload is taken
   * (`400 voice_sample_unusable`); the consent comes first (`409
   * voice_consent_required`).
   */
  @Post('voice-intro/sample')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @BuiltBy('VOICE-01')
  async sample(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: VoiceSampleDto,
  ): Promise<VoiceIntroView> {
    await this.profiles.setSample(user.sub, dto.fileUrl);
    return this.runs.view(user.sub);
  }

  /**
   * Makes the Voice Intro in the caller's own voice. The first one a tier
   * includes takes no points; any other holds the plan's `voice_intro` points
   * (200 by default). Answers `202` with the try `working`; `GET
   * /me/voice-intro` is what the app polls. The points are kept only when the
   * audio is made and given back when it is not (the try says "No points were
   * taken"). Needs an `Idempotency-Key`: the same key again answers the first
   * try (`200`, `Idempotent-Replayed: true`) and takes nothing more. Refused
   * with nothing taken: `409 voice_text_required`, `409 voice_consent_required`,
   * `409 voice_sample_required`, `409 voice_intro_busy`, `402
   * insufficient_points`, `422 points_cap_reached`, `503 voice_unavailable`.
   */
  @Post('voice-intro/generate')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8 to 128 of letters, digits, - or _: one per try.',
  })
  @BuiltBy('VOICE-01')
  async generate(
    @CurrentUser() user: WawuJwtClaims,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<VoiceIntroView> {
    const { view, replayed } = await this.runs.generate(user.sub, key);
    if (replayed) {
      res.status(200);
      res.setHeader('Idempotent-Replayed', 'true');
    }
    return view;
  }
}

/**
 * Anyone's Voice Intro, for a profile (VOICE-01, R-66). Its own leaf under
 * `users`: the public profile route (`GET /users/:wawuId/public-profile`) is a
 * protected route whose response is locked, so the Voice Intro rides on this
 * additive route instead of a new field there (G-VOICE-01-1).
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('users')
export class VoiceIntroPublicController {
  constructor(private readonly profiles: VoiceProfileService) {}

  /** `{ voiceIntro: { url, aiVoice: true } }`, or `{ voiceIntro: null }` for a person with none. `404` for no such person, or one hidden by a block. */
  @Get(':wawuId/voice-intro')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('VOICE-01')
  voiceIntro(
    @CurrentUser() user: WawuJwtClaims,
    @Param('wawuId', ParseUUIDPipe) wawuId: string,
  ): Promise<PublicVoiceIntroView> {
    return this.profiles.publicIntro(user.sub, wawuId);
  }
}
