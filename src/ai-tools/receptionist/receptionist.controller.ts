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
  Put,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import type { WawuJwtClaims } from '../../common/auth/wawu-jwt-claims.interface';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { WawuAuthGuard } from '../../common/guards/wawu-auth.guard';
import { BuiltBy } from '../../money/money-contract';
import { AiJobService } from '../ai-job.service';
import type { AiJobView } from '../ai-tools-view.type';
import { RECEPTIONIST_TOOL } from '../tools/receptionist.tool';
import {
  AddKnowledgeDto,
  CreateReceptionistMessageDto,
  SaveReceptionistDto,
  StartVoiceSessionDto,
} from './receptionist.dto';
import { ReceptionistService } from './receptionist.service';
import type {
  ReceptionistRemovedView,
  ReceptionistView,
  VoiceSessionView,
} from './receptionist-view.type';

/**
 * The Receptionist (AITOOLS-06, R-109): the creator's own talking AI agent, owner only. Every route works on the caller's
 * own Receptionist (another person's cannot be read or used). R-109 point 3 leaves every other channel out, so there is
 * no route for one. The tool is listed (`GET /ai-tools`) only while
 * `ai.listed.receptionist` is on; while it is off the routes that cost points answer `503 ai_tool_unavailable`.
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('ai-tools/receptionist')
export class ReceptionistController {
  constructor(
    private readonly receptionist: ReceptionistService,
    private readonly jobs: AiJobService,
  ) {}

  /** The caller's Receptionist: whether it is set up, its details, what it knows, and the limits and voices the screen draws. Read-only. */
  @Get()
  @Header('Cache-Control', 'no-store')
  @BuiltBy('AITOOLS-06')
  read(@CurrentUser() user: WawuJwtClaims): Promise<ReceptionistView> {
    return this.receptionist.view(user.sub);
  }

  /**
   * Sets up or changes the Receptionist (`businessName`, `offer`, optional `replyStyle`, `language`, `voiceId`). The
   * first save makes the agent; later saves edit it. A language or voice off the lists, or an empty name or offer, is
   * refused and nothing is created. `503` when it cannot be reached, with nothing changed.
   */
  @Put()
  @Throttle({ medium: { limit: 30, ttl: 60_000 } })
  @Header('Cache-Control', 'no-store')
  @BuiltBy('AITOOLS-06')
  save(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: SaveReceptionistDto,
  ): Promise<ReceptionistView> {
    return this.receptionist.save(user.sub, dto);
  }

  /**
   * Clears the Receptionist: the agent, every document it knew and the earlier messages. `atProvider: pending` means the
   * Hub is still removing a copy: ask again. Always works, also while the tool is off.
   */
  @Delete()
  @Header('Cache-Control', 'no-store')
  @BuiltBy('AITOOLS-06')
  clear(@CurrentUser() user: WawuJwtClaims): Promise<ReceptionistRemovedView> {
    return this.receptionist.clear(user.sub);
  }

  /**
   * Adds something it knows: `kind: text` (`text`), `url` (`url`, an `https` page) or `file` (`fileKey` of a text or PDF
   * uploaded to `ai/input-doc`), with a `name`. At most the limit in `GET /ai-tools/receptionist` (`limits.docsMax`);
   * a text, document or link over its limit, a link that is not `https`, a file type off the list and another person's
   * key are refused with the reason and nothing is created. The profile and listings are NOT read: what it knows is what
   * the person adds.
   */
  @Post('knowledge')
  @HttpCode(201)
  @Throttle({ medium: { limit: 30, ttl: 60_000 } })
  @Header('Cache-Control', 'no-store')
  @BuiltBy('AITOOLS-06')
  addKnowledge(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: AddKnowledgeDto,
  ): Promise<ReceptionistView> {
    return this.receptionist.addKnowledge(user.sub, dto);
  }

  /** Makes it forget one thing: deleted at the provider, then the row. `404 not_found` for another person's. */
  @Delete('knowledge/:id')
  @Header('Cache-Control', 'no-store')
  @BuiltBy('AITOOLS-06')
  removeKnowledge(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ReceptionistView> {
    return this.receptionist.removeKnowledge(user.sub, id);
  }

  /**
   * Sends it a text message: `message` and the `quoteToken` of the `POST /points/quote` for the action
   * `receptionist_message` (units 1). The points are held; the job answers `202 working`; poll `GET /ai-tools/jobs/{id}`:
   * the reply is the done job's `text` output, the points are kept only then and every point goes back on a failure.
   * The same Idempotency-Key twice sends one message. `409 receptionist_not_set_up` before the first save.
   */
  @Post('messages')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8 to 128 of letters, digits, - or _: one per message.',
  })
  @BuiltBy('AITOOLS-06')
  async message(
    @CurrentUser() user: WawuJwtClaims,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: CreateReceptionistMessageDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AiJobView> {
    const { job, replayed } = await this.jobs.createJob(
      RECEPTIONIST_TOOL,
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
   * Starts a talking session: holds the points for the longest session (`limits.voiceMaxMinutes`, the quote is
   * `POST /points/quote` for `receptionist_voice_per_min` with that many units) and answers `{ id, signedUrl,
   * conversationId, maxSeconds }`. The phone talks to the provider on `signedUrl` (used once); the Hub carries no audio.
   * Call `end` when the talk is over.
   */
  @Post('voice-sessions')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8 to 128 of letters, digits, - or _: one per session.',
  })
  @BuiltBy('AITOOLS-06')
  async startVoice(
    @CurrentUser() user: WawuJwtClaims,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: StartVoiceSessionDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<VoiceSessionView> {
    const { session, replayed } = await this.receptionist.startVoice(
      user.sub,
      key,
      dto.quoteToken,
    );
    if (replayed) {
      res.status(200);
      res.setHeader('Idempotent-Replayed', 'true');
    }
    return session;
  }

  /**
   * Ends a talking session: the Hub reads how long it was, keeps the real minutes (rounded up, at most what was held)
   * and gives the rest back. `state: working` means the provider has not closed the conversation yet and the Hub settles
   * it within a minute. A second `end` changes nothing. A session nobody ends is settled at the longest by the sweep.
   */
  @Post('voice-sessions/:id/end')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @BuiltBy('AITOOLS-06')
  endVoice(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<VoiceSessionView> {
    return this.receptionist.endVoice(user.sub, id);
  }
}
