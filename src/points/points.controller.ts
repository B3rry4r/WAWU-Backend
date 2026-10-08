import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { PointsService } from './points.service';
import type { MyPointsView } from './points-view.type';

/**
 * Your points (task POINTS-01, PT5). The caller is the token: the route takes
 * no id of whose points, so nobody else's can be asked for. `no-store`
 * because a hold or a grant changes the answer at any moment.
 *
 * Mounted through MeModule (`/me` is a first segment no other controller
 * declares; MeController has no parameter at `/me/:x` to shadow `points`).
 */
@UseGuards(WawuAuthGuard)
@Controller('me/points')
export class PointsController {
  constructor(private readonly points: PointsService) {}

  /** Balance, live lots with their end dates, the next end, the last 20 movements. */
  @Get()
  @Header('Cache-Control', 'no-store')
  mine(@CurrentUser() user: WawuJwtClaims): Promise<MyPointsView> {
    return this.points.view(user.sub);
  }
}
