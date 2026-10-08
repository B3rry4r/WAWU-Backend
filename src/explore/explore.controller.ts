import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { OptionalWawuAuthGuard } from '../search-response/guards/optional-wawu-auth.guard';
import { ExploreService } from './explore.service';
import {
  ExploreCreatorsQueryDto,
  FeaturedCreatorsQueryDto,
} from './dto/explore-creators-query.dto';

/**
 * EXPLORE-03. Public like search: a signed-out reader gets the lists with
 * `following: false`; a valid token is read so follow state and blocks apply.
 * `explore` is a first segment no other controller uses.
 */
@UseGuards(OptionalWawuAuthGuard)
@Controller('explore')
export class ExploreController {
  constructor(private readonly service: ExploreService) {}

  @Get('categories')
  categories() {
    return this.service.categories();
  }

  @Get('creators')
  creators(
    @Query() query: ExploreCreatorsQueryDto,
    @CurrentUser() user: WawuJwtClaims | undefined,
  ) {
    return this.service.creators(query, user?.sub ?? null);
  }

  @Get('featured-creators')
  featured(
    @Query() query: FeaturedCreatorsQueryDto,
    @CurrentUser() user: WawuJwtClaims | undefined,
  ) {
    return this.service.featured(query, user?.sub ?? null);
  }
}
