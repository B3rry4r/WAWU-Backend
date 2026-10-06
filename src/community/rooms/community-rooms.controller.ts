import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { WawuAuthGuard } from '../../common/guards/wawu-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../../common/auth/wawu-jwt-claims.interface';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import type { Paginated } from '../../common/interceptors/response.interceptor';
import { CreatorAccountGuard } from '../guards/creator-account-guard';
import { CreateCommunityDto } from '../dto/create-community.dto';
import { CommunityRoomsService } from './community-rooms.service';
import type {
  CommunityLinkView,
  CommunityReadView,
  CommunityRoom,
  MyCommunity,
} from './community-room.type';

/**
 * INBOX-01. New routes under /communities for the app; see
 * CommunityRoomsService for what each does.
 *
 * ORDER MATTERS. CommunityController declares GET /communities/:id, which
 * would take GET /communities/mine and answer 400 (not a uuid). This
 * controller is listed first in CommunityModule, so its fixed paths
 * (`mine`, `rooms`, `links/:slug`) are matched before that one.
 */
@UseGuards(WawuAuthGuard)
@Controller('communities')
export class CommunityRoomsController {
  constructor(private readonly rooms: CommunityRoomsService) {}

  /**
   * The caller's communities: rooms they host and rooms they were let into,
   * newest activity first, each with its share link, last message and unread
   * count. A request still waiting for the host is not listed.
   */
  @Get('mine')
  mine(
    @CurrentUser() user: WawuJwtClaims,
    @Query() { page, perPage }: PaginationQueryDto,
  ): Promise<Paginated<MyCommunity>> {
    return this.rooms.mine(user.sub, page, perPage);
  }

  /**
   * Create a room, the way the app does. Creator accounts only, like
   * POST /communities. A private room needs a cover image (`imageUrl`):
   * without one the answer is 400 "A private room needs a cover image.".
   * The answer carries the room's share link.
   */
  @Post('rooms')
  @UseGuards(CreatorAccountGuard)
  createRoom(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: CreateCommunityDto,
  ): Promise<CommunityRoom> {
    return this.rooms.createRoom(user.sub, dto);
  }

  /**
   * Open a `wawu/c/<slug>` link: the room it names, members or not. Capitals
   * are accepted. 404 "No community has this link." otherwise.
   */
  @Get('links/:slug')
  resolve(
    @Param('slug') slug: string,
    @CurrentUser() user: WawuJwtClaims,
  ): Promise<CommunityRoom> {
    return this.rooms.resolve(slug, user.sub);
  }

  /** The room's share link, made from its name the first time it is asked for. */
  @Get(':id/link')
  link(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: WawuJwtClaims,
  ): Promise<CommunityLinkView> {
    return this.rooms.linkFor(id, user.sub);
  }

  /**
   * The caller has read the room up to now; its unread count on
   * GET /communities/mine goes to 0. The host or an approved member only
   * (403 otherwise). 200, not 201: it moves a marker.
   */
  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  markRead(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: WawuJwtClaims,
  ): Promise<CommunityReadView> {
    return this.rooms.markRead(id, user.sub);
  }
}
