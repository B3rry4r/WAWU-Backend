import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { PrivacySettingsService } from './privacy-settings.service';
import { UpdatePrivacySettingsDto } from './dto/update-privacy-settings.dto';
import type { PrivacySettings } from '../common/types';

/**
 * registry.json "PrivacySettings": GET/PATCH /settings/privacy, both
 * `roles: ["any"]` — any authenticated WAWU user, no creator gate.
 */
@Controller('settings/privacy')
@UseGuards(WawuAuthGuard)
export class PrivacySettingsController {
  constructor(private readonly privacySettingsService: PrivacySettingsService) {}

  @Get()
  async getMySettings(@CurrentUser() user: WawuJwtClaims): Promise<PrivacySettings> {
    return this.privacySettingsService.getOrCreate(user.sub);
  }

  @Patch()
  async updateMySettings(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: UpdatePrivacySettingsDto,
  ): Promise<PrivacySettings> {
    return this.privacySettingsService.update(user.sub, dto);
  }
}
