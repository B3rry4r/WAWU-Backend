import { Controller, Get, UseGuards } from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import {
  UserSuspensionService,
  type MySuspensionView,
} from './user-suspension.service';

/**
 * USER-SUSPEND (R-121). `GET /me/suspension`: the signed-in person's own state, for the banner on Me. A read, so a
 * suspended person can always call it. It never says who suspended them, why, or what the moderator wrote.
 */
@Controller('me/suspension')
@UseGuards(WawuAuthGuard)
export class MeSuspensionController {
  constructor(private readonly service: UserSuspensionService) {}

  @Get()
  mine(@CurrentUser() user: WawuJwtClaims): Promise<MySuspensionView> {
    return this.service.mine(user.sub);
  }
}
