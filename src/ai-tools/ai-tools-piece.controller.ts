import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { BuiltBy } from '../money/money-contract';
import { GatesPublishing } from '../plans/publishing-offers.interceptor';
import { AiJobService } from './ai-job.service';
import { MakePieceDto } from './ai-tools.dto';
import type { AiPieceView } from './ai-tools-view.type';

/**
 * The result of a Studio job into Create (AITOOLS-08, R-109). Its own
 * controller, beside `AiToolsController`, because it is the one AI tools route
 * that stands behind the publishing gate: the file it makes is an upload of the
 * person's own, counted like any upload, so a person who may not publish gets
 * the same answer the presign gives them.
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('ai-tools')
export class AiToolsPieceController {
  constructor(private readonly jobs: AiJobService) {}

  /**
   * "Make it a piece": copies the chosen output of a finished job into the
   * person's own content folder (`content/full/<id>/...`) and answers what
   * Create's draft holds: `{ format, full: { key, fileUrl, contentType, bytes,
   * name }, suggestedTitle }`. Send `full` as the draft's file (`fullAsset`) and
   * the format as the piece's format; `POST /content` and its tier and place
   * gates run as today. Nothing is published, and no preview is made: the
   * preview stays the person's own step in Create.
   *
   * Only the person's own finished job (`404 not_found` for another person's,
   * `409 job_not_ready` for one still working or failed). An output no Create
   * format takes (a FLAC dub, an AAC clip, words) is `409 no_format`. A person
   * who may not publish gets the presign's `402 tier_required`; one with no room
   * gets its `413 storage_limit_reached`, and nothing is copied. Needs an
   * `Idempotency-Key`; the same call again answers the same key (header
   * `Idempotent-Replayed: true`) until the person releases it with `POST
   * /uploads/release`, as for any abandoned upload.
   */
  @Post('jobs/:id/piece')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @GatesPublishing()
  @Throttle({ medium: { limit: 30, ttl: 60_000 } })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8 to 128 of letters, digits, - or _.',
  })
  @BuiltBy('AITOOLS-08')
  async makePiece(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: MakePieceDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AiPieceView> {
    const { piece, replayed } = await this.jobs.makePiece(
      user.sub,
      id,
      dto.outputIndex,
      key,
    );
    if (replayed) res.setHeader('Idempotent-Replayed', 'true');
    return piece;
  }
}
