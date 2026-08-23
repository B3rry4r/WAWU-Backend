import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { OptionalWawuAuthGuard } from '../search-response/guards/optional-wawu-auth.guard';
import { CreatorDiscoveryService } from './creator-discovery.service';
import { ListCreatorsQueryDto } from './dto/list-creators-query.dto';

/**
 * GET /creators — browse the people on the platform.
 *
 * Optional auth, like search: browsing creators is public, and a signed-out
 * reader gets the same list with `following: false` throughout rather than a
 * 401. A valid token is still read when present, which is the only way the
 * follow state on each card can be right.
 *
 * ── ROUTE ORDER ────────────────────────────────────────────────────────────
 * `creators/:wawuId/follow` (FollowRelationshipController) is a deeper path
 * and cannot collide with this one. There is deliberately no `@Get(':wawuId')`
 * here: a catch-all at this depth is the exact shape that has bitten this
 * codebase before (`@Controller('services')`), and a single creator is already
 * served by `/users/:wawuId/public-profile`.
 */
@UseGuards(OptionalWawuAuthGuard)
@Controller('creators')
export class CreatorDiscoveryController {
  constructor(private readonly service: CreatorDiscoveryService) {}

  @Get()
  list(
    @Query() query: ListCreatorsQueryDto,
    @CurrentUser() user: WawuJwtClaims | undefined,
  ) {
    return this.service.list(query, user?.sub ?? null);
  }
}
