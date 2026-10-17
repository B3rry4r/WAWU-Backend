import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiHeader, ApiResponse } from '@nestjs/swagger';
import type { Response } from 'express';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { CreatorAccountGuard } from '../common/guards/creator-account.guard';
import { PaidDmService } from './paid-dm.service';
import { PaidDmPauseService } from './paid-dm-pause.service';
import { PaidDmSettingsService } from './paid-dm-settings.service';
import {
  PaidDmEarnQueryDto,
  UpdatePaidDmSettingsDto,
} from './dto/paid-dm-settings.dto';
import {
  PaidDmPageQueryDto,
  PaidDmReplyDto,
  PaidDmThreadsQueryDto,
} from './dto/paid-dm.dto';
import type {
  PaidDmAvailability,
  PaidDmQuestion,
  PaidDmQueuePage,
  PaidDmEarn,
  PaidDmSettings,
  PaidDmStanding,
  PaidDmThreadDetail,
  PaidDmThreadPage,
  PaidDmWaiting,
} from './paid-dm-view.type';

/**
 * The shape an `Idempotency-Key` takes everywhere in the Hub (docs/contract/
 * CONVENTIONS.md section 4): 8 to 128 characters of letters, digits, hyphen
 * and underscore.
 */
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * The header is optional on the reply route. Absent: the reply runs exactly
 * as it always has. Present: it must be one well-formed value, or nothing is
 * stored (a key the Hub cannot hold is refused, not ignored).
 */
function readIdempotencyKey(
  header: string | string[] | undefined,
): string | undefined {
  if (header === undefined) return undefined;
  if (typeof header !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(header)) {
    throw new BadRequestException(
      'Idempotency-Key must be one value of 8 to 128 letters, digits, hyphens or underscores.',
    );
  }
  return header;
}

/**
 * Paid questions as threads and the creator's waiting list (task INBOX-08).
 * New routes under `/paid-dm`, a first segment no other route uses, so none
 * of the live `/dm/*` routes is touched or shadowed.
 */
@UseGuards(WawuAuthGuard)
@Controller('paid-dm')
export class PaidDmController {
  constructor(
    private readonly paidDm: PaidDmService,
    private readonly pause: PaidDmPauseService,
    private readonly settings: PaidDmSettingsService,
  ) {}

  /** The creator's waiting list: soonest deadline first, with the total waiting. */
  @Get('queue')
  @UseGuards(CreatorAccountGuard)
  queue(
    @CurrentUser() user: WawuJwtClaims,
    @Query() query: PaidDmPageQueryDto,
  ): Promise<PaidDmQueuePage> {
    return this.paidDm.queue(user.sub, query.cursor, query.limit);
  }

  /** How many questions wait on the creator and what they were paid (I9), over every one of them. */
  @Get('waiting')
  @UseGuards(CreatorAccountGuard)
  waiting(@CurrentUser() user: WawuJwtClaims): Promise<PaidDmWaiting> {
    return this.paidDm.waiting(user.sub);
  }

  /** The creator's own standing on unanswered paid questions: warned, paused, and when it ends (R-13). */
  @Get('standing')
  @ApiResponse({
    status: 403,
    description: 'The caller is not a creator account.',
  })
  @UseGuards(CreatorAccountGuard)
  standing(@CurrentUser() user: WawuJwtClaims): Promise<PaidDmStanding> {
    return this.pause.standing(user.sub);
  }

  /** The creator's paid message settings with everything I21 to I23 draw (price, reply window, share, standing). */
  @Get('settings')
  @ApiResponse({
    status: 403,
    description: 'The caller is not a creator account.',
  })
  @UseGuards(CreatorAccountGuard)
  getSettings(@CurrentUser() user: WawuJwtClaims): Promise<PaidDmSettings> {
    return this.settings.get(user.sub);
  }

  /** What the creator keeps of one message at a price they are typing (I21, R-21). Read only; saves nothing. */
  @Get('settings/earn')
  @ApiResponse({
    status: 400,
    description:
      'The price is missing, not an integer, outside the bounds, or not a whole number of naira.',
  })
  @ApiResponse({
    status: 403,
    description: 'The caller is not a creator account.',
  })
  @UseGuards(CreatorAccountGuard)
  earn(@Query() query: PaidDmEarnQueryDto): PaidDmEarn {
    return this.settings.earnAt(query.priceKobo);
  }

  /** Saves the creator's paid message settings. Refused while paid messages are paused (R-13). */
  @Put('settings')
  @ApiResponse({
    status: 400,
    description:
      'The price is not a whole number of naira, no price is set, or the reply time is not on offer.',
  })
  @ApiResponse({
    status: 403,
    description:
      'The caller is not a creator account, or paid messages are paused (reason.code paid_messages_paused).',
  })
  @UseGuards(CreatorAccountGuard)
  saveSettings(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: UpdatePaidDmSettingsDto,
  ): Promise<PaidDmSettings> {
    return this.settings.save(user.sub, dto);
  }

  /** Whether a creator's paid messages are switched off, and until when (I8). Any signed-in user. */
  @Get('creators/:wawuId/availability')
  @ApiResponse({ status: 400, description: 'wawuId is not a UUID.' })
  @ApiResponse({
    status: 404,
    description: 'The account has no creator state.',
  })
  availability(
    @Param('wawuId', ParseUUIDPipe) wawuId: string,
    @CurrentUser() user: WawuJwtClaims,
  ): Promise<PaidDmAvailability> {
    return this.pause.availability(wawuId, undefined, user.sub);
  }

  /** The caller's threads, one per person, latest activity first. `as=creator` reads the creator side. */
  @Get('threads')
  threads(
    @CurrentUser() user: WawuJwtClaims,
    @Query() query: PaidDmThreadsQueryDto,
  ): Promise<PaidDmThreadPage> {
    return this.paidDm.threads(
      user.sub,
      query.as ?? 'fan',
      query.cursor,
      query.limit,
    );
  }

  /** One thread: every question with all its reply bubbles. */
  @Get('threads/:wawuId')
  thread(
    @CurrentUser() user: WawuJwtClaims,
    @Param('wawuId', ParseUUIDPipe) wawuId: string,
    @Query() query: PaidDmThreadsQueryDto,
  ): Promise<PaidDmThreadDetail> {
    return this.paidDm.thread(
      user.sub,
      query.as ?? 'fan',
      wawuId,
      query.cursor,
      query.limit,
    );
  }

  /** Add a reply bubble to a question, while its window is open. */
  @Post('questions/:messageId/replies')
  @UseGuards(CreatorAccountGuard)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Optional. One value per reply, made by the app when the creator first taps Reply and sent again unchanged on every retry of that same reply (never reused for another). Per creator and key the reply is stored once; a repeat, or a second request with the same key at the same moment, answers with the question as it stands, the first reply in it once, and the header `Idempotent-Replayed: true`, and stores and releases nothing again. The same key for another question or other words is `409` with `reason: idempotency_key_reused`. A value that is not 8 to 128 of [A-Za-z0-9_-] is `400`. Without it the reply behaves as it always has.',
    schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{8,128}$' },
  })
  async reply(
    @CurrentUser() user: WawuJwtClaims,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @Body() dto: PaidDmReplyDto,
    @Headers('idempotency-key') idempotencyKey: string | string[] | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PaidDmQuestion> {
    const key = readIdempotencyKey(idempotencyKey);
    const { question, replayed } = await this.paidDm.reply(
      user.sub,
      messageId,
      dto.text,
      key,
    );
    if (replayed) res.setHeader('Idempotent-Replayed', 'true');
    return question;
  }
}
