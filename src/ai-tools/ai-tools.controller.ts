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
import { CreateVoiceoverJobDto } from './ai-tools.dto';
import { AiToolsService } from './ai-tools.service';
import type { AiJobView, AiToolsView } from './ai-tools-view.type';

/**
 * The AI tools (AITOOLS-01, R-43, R-61, PT1 and PT2). The points a job costs
 * are held, kept or given back by POINTS-03; no route here moves naira.
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
   * One job as it stands now: `working`, `done` with `audioUrl`, or `failed`
   * with the words "No points were taken" (PT2c). Only the person who ran it
   * reads it; another person's job and one that is not there are the same
   * `404 not_found`.
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
