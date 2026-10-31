import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Put,
  UseGuards,
} from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import {
  CommunityRoomModerationService,
  type RoomModerationView,
} from './community-room-moderation.service';

/**
 * MOD-ROOMS (R-122). What a room's host can do in their own room, and what a member needs to know about it. New routes
 * only; the room's own routes are unchanged.
 *
 *   GET    /communities/:id/moderation                 who is muted (the host), or whether I am (a member)
 *   DELETE /communities/:id/messages/:messageId        the host deletes any message in the room
 *   PUT    /communities/:id/mutes/:userWawuId          the host mutes a member
 *   DELETE /communities/:id/mutes/:userWawuId          the host unmutes them
 *
 * Only the room's host may delete or mute (403 for a member or a stranger). Removing a member is not here (INBOX-25).
 */
@UseGuards(WawuAuthGuard)
@Controller('communities/:id')
export class CommunityRoomModerationController {
  constructor(private readonly moderation: CommunityRoomModerationService) {}

  @Get('moderation')
  view(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: WawuJwtClaims,
  ): Promise<RoomModerationView> {
    return this.moderation.view(id, user.sub);
  }

  @Delete('messages/:messageId')
  @HttpCode(HttpStatus.OK)
  deleteMessage(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('messageId', new ParseUUIDPipe()) messageId: string,
    @CurrentUser() user: WawuJwtClaims,
  ): Promise<{ removed: true }> {
    return this.moderation.deleteMessage(id, user.sub, messageId);
  }

  @Put('mutes/:userWawuId')
  @HttpCode(HttpStatus.OK)
  mute(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('userWawuId', new ParseUUIDPipe({ version: '4' }))
    userWawuId: string,
    @CurrentUser() user: WawuJwtClaims,
  ): Promise<{ muted: true }> {
    return this.moderation.mute(id, user.sub, userWawuId);
  }

  @Delete('mutes/:userWawuId')
  @HttpCode(HttpStatus.OK)
  unmute(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('userWawuId', new ParseUUIDPipe({ version: '4' }))
    userWawuId: string,
    @CurrentUser() user: WawuJwtClaims,
  ): Promise<{ muted: false }> {
    return this.moderation.unmute(id, user.sub, userWawuId);
  }
}
