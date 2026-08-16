import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { CreatorStateService } from './creator-state.service';
import { UpdateDmSettingsDto } from './dto/update-dm-settings.dto';

/**
 * .pipeline/registry.json CreatorState endpoints. Both require an
 * authenticated caller (WawuAuthGuard) who is a creator — the "creator"
 * role gate is enforced in the service (CreatorStateService), not
 * re-checked here, matching CLAUDE.md's "gates come from one place" rule.
 */
@UseGuards(WawuAuthGuard)
@Controller('creator')
export class CreatorStateController {
  constructor(private readonly creatorStateService: CreatorStateService) {}

  @Get('state')
  getState(@CurrentUser() user: WawuJwtClaims) {
    return this.creatorStateService.getState(user.sub);
  }

  @Patch('dm-settings')
  updateDmSettings(@CurrentUser() user: WawuJwtClaims, @Body() dto: UpdateDmSettingsDto) {
    return this.creatorStateService.updateDmSettings(user.sub, dto);
  }
}
