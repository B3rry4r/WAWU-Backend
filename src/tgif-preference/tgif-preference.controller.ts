import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import {
  TgifPreferenceService,
  type TgifPreferenceView,
} from './tgif-preference.service';
import { UpdateTgifPreferenceDto } from './dto/update-tgif-preference.dto';

/**
 * HOME-11: GET and PATCH /settings/tgif, the caller's own TGIF-on-Today
 * preference. Own data only: the user id comes from the token, never the path.
 */
@Controller('settings/tgif')
@UseGuards(WawuAuthGuard)
export class TgifPreferenceController {
  constructor(private readonly preference: TgifPreferenceService) {}

  @Get()
  get(@CurrentUser() user: WawuJwtClaims): Promise<TgifPreferenceView> {
    return this.preference.get(user.sub);
  }

  @Patch()
  update(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: UpdateTgifPreferenceDto,
  ): Promise<TgifPreferenceView> {
    return this.preference.set(user.sub, dto.show);
  }
}
