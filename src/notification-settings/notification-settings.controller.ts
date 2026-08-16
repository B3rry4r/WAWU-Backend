import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { NotificationSettingsService } from './notification-settings.service';
import { UpdateNotificationSettingsDto } from './dto/update-notification-settings.dto';

/** registry.json § NotificationSettings — both endpoints are roles: ["any"]. */
@UseGuards(WawuAuthGuard)
@Controller('settings/notifications')
export class NotificationSettingsController {
  constructor(private readonly notificationSettingsService: NotificationSettingsService) {}

  @Get()
  get(@CurrentUser() user: WawuJwtClaims) {
    return this.notificationSettingsService.get(user.sub);
  }

  @Patch()
  update(@CurrentUser() user: WawuJwtClaims, @Body() dto: UpdateNotificationSettingsDto) {
    return this.notificationSettingsService.update(user.sub, dto);
  }
}
