import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { CreatorAccountGuard } from './guards/creator-account-guard';
import { PaidDmService } from './paid-dm.service';
import {
  PaidDmPageQueryDto,
  PaidDmReplyDto,
  PaidDmThreadsQueryDto,
} from './dto/paid-dm.dto';
import type {
  PaidDmQuestion,
  PaidDmQueuePage,
  PaidDmThreadDetail,
  PaidDmThreadPage,
} from './paid-dm-view.type';

/**
 * Paid questions as threads and the creator's waiting list (task INBOX-08).
 * New routes under `/paid-dm`, a first segment no other route uses, so none
 * of the live `/dm/*` routes is touched or shadowed.
 */
@UseGuards(WawuAuthGuard)
@Controller('paid-dm')
export class PaidDmController {
  constructor(private readonly paidDm: PaidDmService) {}

  /** The creator's waiting list: soonest deadline first, with the total waiting. */
  @Get('queue')
  @UseGuards(CreatorAccountGuard)
  queue(
    @CurrentUser() user: WawuJwtClaims,
    @Query() query: PaidDmPageQueryDto,
  ): Promise<PaidDmQueuePage> {
    return this.paidDm.queue(user.sub, query.cursor, query.limit);
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
