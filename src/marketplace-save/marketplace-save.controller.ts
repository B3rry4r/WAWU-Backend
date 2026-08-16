import { Body, Controller, Delete, Param, Post, UseGuards } from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { MarketplaceSaveService } from './marketplace-save.service';
import { CreateMarketplaceSaveDto } from './dto/create-marketplace-save.dto';
import type { MarketplaceSave } from '../common/types';

/**
 * registry.json § MarketplaceSave — the ONLY marketplace resource this
 * backend owns (supersede S-5). Product catalog stays on frontend mocks /
 * a future WAWUBasket-API integration.
 */
@Controller('marketplace/saves')
@UseGuards(WawuAuthGuard)
export class MarketplaceSaveController {
  constructor(private readonly marketplaceSaveService: MarketplaceSaveService) {}

  @Post()
  create(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: CreateMarketplaceSaveDto,
  ): Promise<MarketplaceSave> {
    return this.marketplaceSaveService.save(user.sub, dto);
  }

  @Delete(':productId')
  remove(@CurrentUser() user: WawuJwtClaims, @Param('productId') productId: string): Promise<void> {
    return this.marketplaceSaveService.unsave(user.sub, productId);
  }
}
