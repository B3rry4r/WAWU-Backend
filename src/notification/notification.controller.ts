import {
  Body,
  Controller,
  Get,
  HttpCode,
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
import { MarkAllReadDto } from './dto/mark-all-read.dto';
import { NotificationService } from './notification.service';
import type { NotificationsResponse } from '../common/types';

/** registry.json § Notification — both endpoints are roles: ["any"], i.e. any authenticated WAWU user. */
@UseGuards(WawuAuthGuard)
@Controller('notifications')
export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  @Get()
  list(
    @CurrentUser() user: WawuJwtClaims,
    @Query() { page, perPage }: PaginationQueryDto,
  ): Promise<NotificationsResponse> {
    return this.notificationService.list(user.sub, page, perPage);
  }

  @Post('mark-all-read')
  @HttpCode(200)
  async markAllRead(@CurrentUser() user: WawuJwtClaims, @Body() _body: MarkAllReadDto): Promise<void> {
    await this.notificationService.markAllRead(user.sub);
  }

  /**
   * Mark ONE notification read — what opening it does.
   *
   * Declared AFTER `mark-all-read` because Nest matches in declaration order
   * and `:id` would otherwise swallow the literal segment. `ParseUUIDPipe`
   * would reject 'mark-all-read' anyway, but relying on a 400 to protect a
   * route is not the same as the route being reachable.
   *
   * Version-UNPINNED, matching every other id route in this codebase: the
   * ids in the data are facts, and `@default(uuid())` is not the only thing
   * that has ever written one.
   */
  @Post(':id/read')
  @HttpCode(200)
  async markRead(
    @CurrentUser() user: WawuJwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() _body: MarkAllReadDto,
  ): Promise<void> {
    await this.notificationService.markRead(user.sub, id);
  }
}
