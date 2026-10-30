import {
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import type { TierOfferSeenView, TierOfferView } from './plans-view.type';
import { TierOfferService } from './tier-offer.service';

/**
 * The tier offer shown right after sign-up (TIER-OFFER, R-94). Own data only:
 * the person is the token's, never a field. Two literal leaves under `/me`;
 * neither meets `/me/tier` (a different leaf) or a parameter route.
 */
@UseGuards(WawuAuthGuard)
@Controller('me/tier-offer')
export class TierOfferController {
  constructor(private readonly offer: TierOfferService) {}

  /** Whether to draw the offer now, and whether it has its close X. `no-store`: the answer is the caller's own. */
  @Get()
  @Header('Cache-Control', 'no-store')
  get(@CurrentUser() user: WawuJwtClaims): Promise<TierOfferView> {
    return this.offer.view(user.sub);
  }

  /** The offer has been drawn for this person: it is not offered again, on any phone. */
  @Post('seen')
  @HttpCode(HttpStatus.OK)
  seen(@CurrentUser() user: WawuJwtClaims): Promise<TierOfferSeenView> {
    // R-105: the row is written whichever way `tier_offer.every_start_on` is set. Only with it off does the row
    // stop the offer; with it on (the default) the offer comes on every start. The summary above is the
    // contract's published text (a fenced file), so it is left as it was.
    return this.offer.markSeen(user.sub);
  }
}
