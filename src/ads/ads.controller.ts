import { Controller, Get, Header, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { AdsService } from './ads.service';
import type { AdCardView } from './ads-view.type';
import { ServeAdQueryDto } from './dto/ads.dto';

/**
 * Task ADS-04 (R-15). `ads` is a first segment no other controller uses.
 * Any signed-in account may ask; the answer is the same for everyone except
 * that an event whose host is blocked either way is skipped.
 */
@UseGuards(WawuAuthGuard)
@Controller('ads')
export class AdsController {
  constructor(private readonly ads: AdsService) {}

  /**
   * The one live sponsored card for a placement, or `data: null` when nothing
   * is eligible (the app draws no card and no empty frame). Never cached: a
   * card must stop the moment its window ends or an admin pauses it.
   */
  @Get()
  @Header('Cache-Control', 'no-store')
  serve(
    @CurrentUser() user: WawuJwtClaims,
    @Query() query: ServeAdQueryDto,
  ): Promise<AdCardView | null> {
    return this.ads.serve(user.sub, query.placement);
  }
}
