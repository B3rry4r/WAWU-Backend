import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
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
  reply(
    @CurrentUser() user: WawuJwtClaims,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @Body() dto: PaidDmReplyDto,
  ): Promise<PaidDmQuestion> {
    return this.paidDm.reply(user.sub, messageId, dto.text);
  }
}
