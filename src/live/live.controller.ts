import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { LiveCatchUpQueryDto } from './dto/live.dto';
import { LiveCatchUpService } from './live-catch-up.service';
import type { LiveCatchUp } from './live-event.type';

/**
 * Live updates for chat (task INBOX-02). The socket itself is at
 * `/api/hub/live` (LiveGateway); this is its catch-up. A first segment no
 * other route uses.
 */
@UseGuards(WawuAuthGuard)
@Controller('live')
export class LiveController {
  constructor(private readonly catchUps: LiveCatchUpService) {}

  /** What the caller missed since a cursor: messages and read marks, oldest first. */
  @Get('catch-up')
  catchUp(
    @CurrentUser() user: WawuJwtClaims,
    @Query() query: LiveCatchUpQueryDto,
  ): Promise<LiveCatchUp> {
    return this.catchUps.catchUp(user.sub, query.cursor, query.limit);
  }
}
