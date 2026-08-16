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
import { PaginationQueryDto } from '../common/dto/pagination.dto';
import { DirectMessageService } from './direct-message.service';
import { CreatorAccountGuard } from './guards/creator-account-guard';
import { SendDmDto } from './dto/send-dm.dto';
import { VerifyDmDto } from './dto/verify-dm.dto';
import { RespondDmDto } from './dto/respond-dm.dto';

/**
 * registry.json "DirectMessage" — task brief's frozen endpoint list.
 *
 * Route-ordering note: GET 'inbox' and GET 'threads' are declared before
 * GET ':messageId' below so Express/Nest matches the static segments first
 * — declaring ':messageId' earlier would swallow both literal paths as a
 * (non-UUID, then 400'd by ParseUUIDPipe) messageId param instead.
 *
 * Shares the 'dm' controller path prefix with the separately-registered
 * DmReportModule's DmReportController (`POST /dm/:messageId/report`) — no
 * route collision: every path below has a distinct literal segment or
 * segment count from that endpoint.
 */
@UseGuards(WawuAuthGuard)
@Controller('dm')
export class DirectMessageController {
  constructor(private readonly directMessageService: DirectMessageService) {}

  @Post(':creatorWawuId/send')
  sendInit(
    @CurrentUser() user: WawuJwtClaims,
    @Param('creatorWawuId', ParseUUIDPipe) creatorWawuId: string,
    @Body() dto: SendDmDto,
  ) {
    return this.directMessageService.sendInit(user.sub, creatorWawuId, dto);
  }

  @Post(':messageId/send/verify')
  sendVerify(
    @CurrentUser() user: WawuJwtClaims,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @Body() dto: VerifyDmDto,
  ) {
    return this.directMessageService.sendVerify(user.sub, messageId, dto);
  }

  @Post(':messageId/respond')
  @UseGuards(CreatorAccountGuard)
  respond(
    @CurrentUser() user: WawuJwtClaims,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @Body() dto: RespondDmDto,
  ) {
    return this.directMessageService.respond(user.sub, messageId, dto);
  }

  @Get('inbox')
  @UseGuards(CreatorAccountGuard)
  inbox(
    @CurrentUser() user: WawuJwtClaims,
    @Query() query: PaginationQueryDto,
  ) {
    return this.directMessageService.inbox(user.sub, query.page, query.perPage);
  }

  @Get('threads')
  threads(
    @CurrentUser() user: WawuJwtClaims,
    @Query() query: PaginationQueryDto,
  ) {
    return this.directMessageService.threads(
      user.sub,
      query.page,
      query.perPage,
    );
  }

  @Get(':messageId')
  findOne(
    @CurrentUser() user: WawuJwtClaims,
    @Param('messageId', ParseUUIDPipe) messageId: string,
  ) {
    return this.directMessageService.findOne(user.sub, messageId);
  }
}
