import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
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
}
